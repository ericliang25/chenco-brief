// functions/api/push.js  (deployed path — see deploy-function.sh)
//
// Cloudflare Pages Function that proxies "Save & Push" requests from the
// live chenco-brief.pages.dev site to GitHub.
//
// Why this exists: the site is public. Any token embedded in the page's
// client-side JS could be read by anyone via view-source, so the page can
// never hold a working GitHub credential itself. This function holds the
// credential instead, server-side, in a Cloudflare environment variable
// that is never sent to the browser. The client POSTs the updated page
// HTML here; this function does the actual GitHub commit.
//
// Setup (one-time, in the Cloudflare dashboard):
//   Workers & Pages -> chenco-brief -> Settings -> Environment variables
//   -> Production -> Add variable
//     Name:  GITHUB_TOKEN
//     Value: <a GitHub PAT (classic, repo scope) with push access to
//             ericliang25/chenco-brief>
//   Encrypt it, save, then trigger a new deployment so the function picks
//   it up (env vars only apply to deployments created after they're set).

const REPO = "ericliang25/chenco-brief";
const FILE_PATH = "index.html";
const BRANCH = "main";

export async function onRequestPost(context) {
  const { request, env } = context;

  const token = env.GITHUB_TOKEN;
  if (!token) {
    return json({ ok: false, error: "Server not configured: GITHUB_TOKEN environment variable is missing. Set it in the Cloudflare Pages dashboard and redeploy." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "Invalid request body — expected JSON with an 'html' field." }, 400);
  }

  const html = body && body.html;
  if (!html || typeof html !== "string") {
    return json({ ok: false, error: "Missing 'html' field in request body." }, 400);
  }

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "chenco-brief-push-function",
  };

  // 1. Get the current file SHA (required by GitHub's contents API for updates).
  let sha;
  try {
    const metaRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, { headers });
    const metaBody = await safeJson(metaRes);
    if (!metaRes.ok) {
      return json({ ok: false, error: `GitHub GET failed (${metaRes.status}): ${metaBody?.message || metaRes.statusText}` }, 502);
    }
    sha = metaBody.sha;
  } catch (e) {
    return json({ ok: false, error: `Network error contacting GitHub (GET): ${e.message}` }, 502);
  }

  // 2. Push the new content.
  const encoded = base64Encode(html);
  const date = new Date().toISOString().slice(0, 10);

  try {
    const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Brief update ${date} (via live site)`,
        content: encoded,
        sha,
        branch: BRANCH,
      }),
    });
    const result = await safeJson(putRes);
    if (!putRes.ok) {
      return json({ ok: false, error: `GitHub PUT failed (${putRes.status}): ${result?.message || putRes.statusText}` }, 502);
    }
    return json({ ok: true, commit: result?.commit?.sha });
  } catch (e) {
    return json({ ok: false, error: `Network error contacting GitHub (PUT): ${e.message}` }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

function base64Encode(str) {
  // UTF-8 safe base64 encoding (the Workers runtime's btoa is Latin1-only).
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
