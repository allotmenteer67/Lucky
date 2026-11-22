// @ts-nocheck
// lucky-read: reads a competition for Lucky Green, from a link or a photo,
// and sends back the details to fill in the comp card, any catches, and a suggested answer.
// The Anthropic key lives in the ANTHROPIC_API_KEY secret (the same one bugid uses), never in the app.
// Nothing about the person entering is ever sent here: only the link or the photo.
// Up to 60 reads a day in total, so a stranger can't run up the bill.
const MODEL = Deno.env.get("LUCKY_MODEL") || "claude-sonnet-5-5";
const DAILY_LIMIT = 60;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function db(path, init) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return fetch(url + "/rest/v1/" + path, {
    ...(init || {}),
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
  });
}

function readJSON(text) {
  try { const t = String(text || ""); return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch (_e) { return null; }
}

// Fetch the comp page and turn it into plain text, keeping link addresses so the entry page can be found.
async function pageText(link) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(link, {
      redirect: "follow",
      signal: ctl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });
    if (!res.ok) return { error: "page " + res.status };
    let html = await res.text();
    const meta = [];
    for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](og:title|og:description|description)["'][^>]*content=["']([^"']*)["']/gi)) meta.push(m[1] + ": " + m[2]);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    html = html
      .replace(/<(script|style|noscript|svg|iframe|title)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
        let abs = href;
        try { abs = new URL(href, res.url).href; } catch (_e) { /* keep as is */ }
        const t = text.replace(/<[^>]+>/g, " ").trim();
        return t ? " " + t + " [" + abs + "] " : " ";
      })
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&pound;/g, "£").replace(/&#163;/g, "£")
      .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
      .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    const text = ("Page title: " + title.trim() + "\n" + meta.join("\n") + "\n\n" + html).slice(0, 45000);
    if (html.length < 300) return { error: "thin", finalUrl: res.url };
    return { text, finalUrl: res.url };
  } catch (_e) {
    return { error: "unreachable" };
  } finally { clearTimeout(timer); }
}

const RULES = `You read UK competitions for a person who wants zero effort and never reads small print.
Reply with JSON only, no other words:
{"found":true or false,
 "reason":"if found is false: one short plain sentence why, e.g. the page needs a login, or it isn't a competition",
 "prize":"short name of the prize, e.g. Weekend in York (not 'Win a...')",
 "value":number in pounds or null if not stated,
 "closes":"YYYY-MM-DD or empty",
 "resultsBy":"YYYY-MM-DD or empty (when winners are told, if stated)",
 "question":"the question to answer, or empty",
 "answer":"the correct answer if you are sure of it, else empty",
 "how":"online, text, phone, post, email or other",
 "website":"the page where the entry form actually is (from the links shown), else the comp page",
 "textNumber":"", "textMessage":"the exact message to text, e.g. WIN YORK", "phoneNumber":"", "postAddress":"", "emailTo":"",
 "cost":number in pounds per entry (0 if free; include the cost of a text or call if stated),
 "often":"once, daily, weekly or any",
 "promoter":"the company running it, from the rules if possible",
 "banned":"" or one short plain sentence if it has one of these: asks for bank or card details to enter a free comp; signs you up to a paid trial or subscription; you must buy something to enter,
 "warnings":[short plain phrases, only those that apply: "Signs you up to their marketing emails" (only if it can't be avoided), "Shares your details with partners", "Prize is really ..." (when much smaller than the headline), "Must follow and share on social media", "Premium-rate number", "Needs you to make an account", "<Brand> customers only", "Ends today"]}
Dates: today is TODAY. If a date has no year, choose the next one after today. Use UK dates (day before month).
Never guess: leave a field empty rather than invent it. Only include a warning if the page or rules show it.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(200, { ok: true, note: "lucky-read is running", version: 1 });

  let input;
  try { input = await req.json(); } catch (_e) { return reply(400, { error: "bad request" }); }
  const link = String(input.link || "").trim();
  const photo = String(input.photo || "");
  if (!link && !photo) return reply(400, { error: "missing" });
  if (photo.length > 6000000) return reply(413, { error: "photo too big" });

  // Count it, and stop at the daily limit.
  const take = await db("rpc/lucky_take_read", { method: "POST", body: JSON.stringify({ p_limit: DAILY_LIMIT }) });
  if (!take.ok) return reply(500, { error: "count failed" });
  if ((await take.json()) !== true) return reply(429, { error: "daily limit" });

  const content = [];
  let finalUrl = "";
  if (photo) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(photo);
    if (!m) return reply(400, { error: "not a photo" });
    content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    content.push({ type: "text", text: "This is a photo of a competition from a newspaper, magazine, leaflet or screen." });
  } else {
    if (!/^https?:\/\//i.test(link)) return reply(400, { error: "not a link" });
    const page = await pageText(link);
    if (page.error) {
      const why = page.error === "thin"
        ? "That page needs a login, or only works in a full browser."
        : "That page wouldn't open from here.";
      return reply(200, { found: false, reason: why, website: page.finalUrl || link });
    }
    finalUrl = page.finalUrl;
    content.push({ type: "text", text: "Competition page (" + finalUrl + "):\n\n" + page.text });
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return reply(500, { error: "no api key" });
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(Deno.env.get("LUCKY_TEST_API") || "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: RULES.replace("TODAY", today), messages: [{ role: "user", content }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return reply(502, { error: "reader", detail: (data.error && data.error.message) || "" });
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = readJSON(text);
  if (!out) return reply(502, { error: "unreadable answer" });

  // Tidy what came back, so the app only ever gets the fields it expects.
  const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 300);
  const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return reply(200, {
    found: out.found !== false,
    reason: s(out.reason),
    prize: s(out.prize, 120),
    value: num(out.value),
    closes: day(out.closes),
    resultsBy: day(out.resultsBy),
    question: s(out.question, 500),
    answer: s(out.answer, 200),
    how: pick(out.how, ["online", "text", "phone", "post", "email", "other"], photo ? "other" : "online"),
    website: s(out.website, 1000) || finalUrl || link,
    textNumber: s(out.textNumber, 30),
    textMessage: s(out.textMessage, 160),
    phoneNumber: s(out.phoneNumber, 30),
    postAddress: s(out.postAddress, 400),
    emailTo: s(out.emailTo, 120),
    cost: num(out.cost) || 0,
    often: pick(out.often, ["once", "daily", "weekly", "any"], "once"),
    promoter: s(out.promoter, 120),
    banned: s(out.banned, 200),
    warnings: (Array.isArray(out.warnings) ? out.warnings : []).map((w) => s(w, 80)).filter(Boolean).slice(0, 5),
  });
});
