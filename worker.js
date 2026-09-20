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
      const facId = url.searchParams.get("fac");
      if (facId) {                                   // a friendly faction's own recording
        const doc = await env.LEDGER.get("fac:" + facId, "json");
        if (!doc) return json({ ours: [], med: [], last: null, note: "this worker is not recording that faction" }, 200, cors);
        return json({ ours: doc.ours, med: [], since: doc.since, last: doc.last }, 200, cors);
      }
      const warId = url.searchParams.get("war");
      if (!warId) return json({ error: "missing ?war= or ?fac=" }, 400, cors);
      const doc = await env.LEDGER.get("war:" + warId, "json");
      if (!doc) return json({ ours: [], med: [], last: null, note: "no recordings for this war yet" }, 200, cors);
      return json({ ours: doc.ours, med: doc.med, since: doc.since, last: doc.last }, 200, cors);
    }
    // Shared terms time: one value per war, so everyone's page agrees instead of
    // each person keeping their own in browser storage. ?set=<unix> writes it,
    // ?set=0 clears it, no ?set reads it.
    if (url.pathname.endsWith("/terms")) {
      const warId = url.searchParams.get("war");
      if (!warId) return json({ error: "missing ?war=" }, 400, cors);
      const key = "terms:" + warId;
      if (url.searchParams.has("set")) {
        const t = +url.searchParams.get("set") || 0;
        if (!t) { await env.LEDGER.delete(key); return json({ terms: null }, 200, cors); }
        await env.LEDGER.put(key, JSON.stringify({ terms: t, at: Math.floor(Date.now() / 1000) }));
        return json({ terms: t }, 200, cors);
      }
      const doc = await env.LEDGER.get(key, "json");
      return json(doc || { terms: null }, 200, cors);
    }
    if (url.pathname.endsWith("/status")) {
      const meta = (await env.LEDGER.get("meta", "json")) || { note: "worker has not ticked yet — check the cron trigger" };
      const now = Math.floor(Date.now() / 1000);
      const tw = testWindow(env, now);
      if (tw) {
        const doc = await env.LEDGER.get("war:test", "json");
        meta.test = { recording: !meta.active, opp: tw.oppId, endsIn: tw.until - now,
                      samples: doc ? doc.ours.length : 0, medOuts: doc ? doc.med.length : 0,
                      last: doc ? doc.last : null, error: meta.testError || null };
      } else if (+env.TEST_UNTIL) meta.test = { recording: false, note: "test window has expired" };
      return json(meta, 200, cors);
    }
    return json({ ok: true, endpoints: ["/snaps?war=ID", "/snaps?fac=ID", "/terms?war=ID", "/status"] }, 200, cors);
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

// Test mode: with no war on, record exactly what a war would record, against a
// nominated faction, under war id "test". Set TEST_UNTIL (unix seconds) and
// TEST_OPP (faction id) as plain vars in wrangler.toml; it stops on its own at
// TEST_UNTIL. Records on every other tick (4 min) to stay well inside the free
// KV tier's 1,000 writes/day, and yields immediately if a real war starts.
function testWindow(env, t) {
  const until = +env.TEST_UNTIL || 0;
  if (!until || t >= until) return null;
  return { warId: "test", oppId: +env.TEST_OPP || 0, start: 0, end: 0, test: true, until };
}

// Friendly factions (FRIEND_FACS, comma-separated ids) get their member statuses
// recorded the same way ours are, under fac:<id>, so their copy of the page can
// draw a real turtle board without running a worker of their own. Sampled less
// often than our own war, and less often again while we are at war, to stay
// inside the free tier's 1,000 KV writes/day.
const FRIEND_KEEP = 14 * 86400;
async function tickFriends(env, t, atWar) {
  const ids = String(env.FRIEND_FACS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!ids.length) return;
  const every = atWar ? 6 : 4;                       // minutes between samples
  if (Math.floor(t / 120) % (every / 2)) return;
  for (const id of ids) {
    try {
      const r = await torn(env, "/faction/" + id + "/members");
      const key = "fac:" + id;
      const doc = (await env.LEDGER.get(key, "json")) || { ours: [], state: {}, since: t };
      const ch = {};
      for (const m of (r.members || [])) {
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
      if (!Object.keys(ch).length) continue;         // nothing changed, nothing to write
      doc.ours.push({ t, ch });
      doc.ours = doc.ours.filter(s => s.t > t - FRIEND_KEEP);
      doc.last = t;
      await env.LEDGER.put(key, JSON.stringify(doc));
    } catch (e) { /* one faction failing must not stop the rest */ }
  }
}

async function tick(env) {
  const t = Math.floor(Date.now() / 1000);
  let meta = (await env.LEDGER.get("meta", "json")) || {};

  // Find the active (or imminent) ranked war; re-check every 10 min.
  // Time-based only: re-checking on every idle tick burned a KV write each time.
  if ((meta.activeCheckedAt || 0) < t - 600) {
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

  await tickFriends(env, t, !!meta.active);

  let act = meta.active;
  if (act && act.start > t) return;
  if (act && act.end && t > act.end + 1800) { // war over (30 min grace)
    meta.active = null;
    await env.LEDGER.put("meta", JSON.stringify(meta));
    act = null;
  }
  if (!act) {                          // no real war — fall back to test mode if armed
    act = testWindow(env, t);
    if (!act) return;
    if (Math.floor(t / 120) % 2) return;  // every other tick: 4 min, half the writes
  }

  const key = "war:" + act.warId;
  const doc = (await env.LEDGER.get(key, "json")) || { ours: [], med: [], state: {}, estate: {}, since: t };
  try {
    const ours = await torn(env, "/faction/members");

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

    doc.last = t;
    await env.LEDGER.put(key, JSON.stringify(doc));
    if (act.test && meta.testError) { meta.testError = null; await env.LEDGER.put("meta", JSON.stringify(meta)); }
  } catch (e) {
    // test errors get their own field: the 10-minute war re-check clears lastError
    if (act.test) meta.testError = String(e.message || e); else meta.lastError = String(e.message || e);
    meta.lastTick = t;
    await env.LEDGER.put("meta", JSON.stringify(meta));
  }
}
