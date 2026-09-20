// War Ledger sync worker — records member statuses 24/7 for Torn ranked wars.
//
// It wakes every 2 minutes (cron), finds your active ranked war automatically,
// samples both factions' member statuses, detects enemy med-outs, and stores
// compact history in Workers KV. The tracker page reads it back via /snaps.
//
// Setup (Cloudflare dashboard, free plan):
//   1. KV: create a namespace (any name).
//   2. Worker: create, paste this file, Deploy.
//   3. Settings → Bindings → add KV namespace, variable name: LEDGER
//   4. Settings → Variables & Secrets → add secrets:
//        TORN_API_KEY   = your Limited key (needs faction API access)
//        TRACKER_TOKEN  = any password you invent (shared with the page)
//   5. Settings → Trigger Events → add Cron: */2 * * * *    (every 2 minutes —
//      keep it at 2, not 1: the free KV tier allows 1,000 writes/day)
//   6. Put the worker URL + token into the tracker page's settings drawer.

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },

  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json"
    };
    if (req.method === "OPTIONS")
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }});
    if (env.TRACKER_TOKEN && url.searchParams.get("token") !== env.TRACKER_TOKEN)
      return json({ error: "bad or missing token" }, 403, cors);

    if (url.pathname.endsWith("/snaps")) {
      const warId = url.searchParams.get("war");
      if (!warId) return json({ error: "missing ?war=" }, 400, cors);
      const doc = await env.LEDGER.get("war:" + warId, "json");
      if (!doc) return json({ ours: [], med: [], last: null, note: "no recordings for this war yet" }, 200, cors);
      return json({ ours: doc.ours, med: doc.med, since: doc.since, last: doc.last }, 200, cors);
    }
    if (url.pathname.endsWith("/status")) {
      const meta = await env.LEDGER.get("meta", "json");
      return json(meta || { note: "worker has not ticked yet — check the cron trigger" }, 200, cors);
    }
    return json({ ok: true, endpoints: ["/snaps?war=ID", "/status"] }, 200, cors);
  }
};

function json(o, status, headers) { return new Response(JSON.stringify(o), { status, headers }); }

async function torn(env, path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch("https://api.torn.com/v2" + path + sep + "key=" + env.TORN_API_KEY + "&comment=WarLedgerWorker");
  const j = await r.json();
  if (j && j.error) throw new Error(j.error.error + " (code " + j.error.code + ")");
  return j;
}

async function tick(env) {
  const t = Math.floor(Date.now() / 1000);
  let meta = (await env.LEDGER.get("meta", "json")) || {};

  // Find the active (or imminent) ranked war; re-check every 10 min when idle.
  if (!meta.active || (meta.activeCheckedAt || 0) < t - 600) {
    try {
      if (!meta.facId) {
        const b = await torn(env, "/faction/basic");
        meta.facId = (b.basic || b).id;
      }
      const rw = await torn(env, "/faction/rankedwars");
      const wars = rw.rankedwars || [];
      const startOf = w => w.start ?? (w.war && w.war.start);
      const endOf = w => (w.end ?? (w.war && w.war.end)) || 0;
      const pick = wars.find(w => startOf(w) <= t && (!endOf(w) || endOf(w) > t))
                || wars.find(w => startOf(w) > t && startOf(w) < t + 900); // starts within 15 min
      if (pick) {
        const facs = pick.factions || [];
        const opp = facs.find(f => (f.id ?? f.faction_id) != meta.facId) || {};
        meta.active = { warId: pick.id ?? pick.war_id, oppId: opp.id ?? opp.faction_id,
                        start: startOf(pick), end: endOf(pick) };
      } else meta.active = null;
      meta.activeCheckedAt = t; meta.lastError = null; meta.lastTick = t;
      await env.LEDGER.put("meta", JSON.stringify(meta));
    } catch (e) {
      meta.lastError = String(e.message || e); meta.activeCheckedAt = t; meta.lastTick = t;
      await env.LEDGER.put("meta", JSON.stringify(meta));
      return;
    }
  }

  const act = meta.active;
  if (!act || act.start > t) return;
  if (act.end && t > act.end + 1800) { // war over (30 min grace)
    meta.active = null;
    await env.LEDGER.put("meta", JSON.stringify(meta));
    return;
  }

  const key = "war:" + act.warId;
  const doc = (await env.LEDGER.get(key, "json")) || { ours: [], med: [], state: {}, estate: {}, since: t };
  try {
    const [ours, enemy] = await Promise.all([
      torn(env, "/faction/members"),
      act.oppId ? torn(env, "/faction/" + act.oppId + "/members") : Promise.resolve({ members: [] })
    ]);

    // our side: record status changes as diffs
    const ch = {};
    for (const m of (ours.members || [])) {
      const st = m.status || {}; const state = st.state || "Okay"; const until = st.until || 0;
      let cause = "";
      if (state === "Hospital") {
        const d = String(st.details || st.description || "").toLowerCase();
        cause = (d.includes("hospitalized by") || d.includes("hospitalised by") ||
                 d.includes("attacked by") || d.includes("mugged by")) ? "enemy" : "self";
      }
      const prev = doc.state[m.id];
      if (!prev || prev[0] !== state || prev[2] !== cause) {
        doc.state[m.id] = [state, until, cause, m.name];
        ch[m.id] = [state, until, cause];
      } else prev[1] = until;
    }
    if (Object.keys(ch).length) doc.ours.push({ t, ch });

    // enemy side: detect med-outs (left hospital well before their timer)
    for (const m of (enemy.members || [])) {
      const st = m.status || {}; const state = st.state || "Okay"; const until = st.until || 0;
      const prev = doc.estate[m.id];
      if (prev && prev[0] === "Hospital" && state !== "Hospital" && prev[1] && t < prev[1] - 90)
        doc.med.push({ id: +m.id, name: m.name, t, early: prev[1] - t });
      doc.estate[m.id] = [state, until, 0, m.name];
    }

    doc.last = t;
    await env.LEDGER.put(key, JSON.stringify(doc));
  } catch (e) {
    meta.lastError = String(e.message || e); meta.lastTick = t;
    await env.LEDGER.put("meta", JSON.stringify(meta));
  }
}
