interface Env {
  UPSTREAM_REPO?: string;
  REFRESH_TOKEN?: string;
}

const DEFAULT_UPSTREAM = "https://ipogo.app/repo";
const edgeCache = (caches as unknown as { default: Cache }).default;
const METADATA_PATHS = [
  "/Release",
  "/Packages",
  "/Packages.gz",
  "/Packages.bz2",
  "/CydiaIcon.png",
  "/repo.xml",
  "/depictions/",
  "/depictions/index.html",
  "/depictions/screenshots.html",
  "/depictions/changelog.html",
  "/depictions/style.css",
  "/depictions/js/jquery.querystring.js",
  "/depictions/js/data-loader-engine.js",
  "/depictions/js/ios_version_check.js",
  "/depictions/com.iteam.ipogo/info.xml",
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

type PackageVersion = { id: string; name: string; version: string; sha256: string | null };

function currentPackages(packages: string): PackageVersion[] {
  const latest = new Map<string, PackageVersion>();
  for (const record of packages.trim().split(/\n\s*\n/)) {
    const id = record.match(/^Package: ([^\r\n]+)$/m)?.[1];
    const version = record.match(/^Version: ([^\r\n]+)$/m)?.[1];
    const name = record.match(/^Name: ([^\r\n]+)$/m)?.[1] ?? id;
    const sha256 = record.match(/^SHA256: ([^\r\n]+)$/m)?.[1] ?? null;
    if (id && name && version) latest.set(id, { id, name, version, sha256 });
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function homePage(origin: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = cacheRequest("/Packages");
  let index = await edgeCache.match(key);
  if (!index) index = await cacheUpstreamPath("/Packages", env);
  else ctx.waitUntil(cacheUpstreamPath("/Packages", env).catch(() => undefined));

  const packages = currentPackages(await index.text());
  const updated = index.headers.get("Last-Modified") || new Date().toUTCString();
  const ipogo = packages.find((item) => item.id === "com.iteam.ipogo");
  const remaining = packages.filter((item) => item.id !== "com.iteam.ipogo");
  const sileo = `sileo://source/${origin}`;
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iPoGo Repository Mirror</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(620px,calc(100% - 32px));padding:38px;border:1px solid #fff;border-radius:16px;background:#000}h1{margin:0 0 8px;font-size:2rem}p,.updated{color:#d0d0d0}.url,.hash{overflow-wrap:anywhere;padding:12px 14px;border:1px solid #666;border-radius:8px;background:#000;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}a.button{display:inline-block;padding:10px 15px;border:1px solid #fff;border-radius:8px;background:#fff;color:#000;text-decoration:none;font-weight:700}a.button.secondary{background:#000;color:#fff}.updated{margin:24px 0 10px;font-size:.92rem}.versions{margin:0;padding:0;list-style:none;border-top:1px solid #555}.versions li{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid #555}.versions span:last-child{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.hash-label{display:block;margin:16px 0 6px;color:#d0d0d0;font-size:.9rem}.hash{font-size:.78rem}details{margin-top:12px}summary{cursor:pointer;color:#d0d0d0}.empty{color:#aaa}</style></head>
<body><main class="card"><h1>iPoGo Repository Mirror</h1><p>A Cloudflare Worker mirror of the iPoGo package repository.</p><div class="url">${origin}</div><div class="actions"><a class="button" href="${sileo}">Add to Sileo</a><a class="button secondary" href="https://ipogo.app/repo">Origin repository</a></div><p class="updated">Last updated: ${escapeHtml(updated)}</p>${ipogo ? `<ul class="versions"><li><span>${escapeHtml(ipogo.name)}</span><span>${escapeHtml(ipogo.version)}</span></li></ul>${ipogo.sha256 ? `<span class="hash-label">iPoGo .deb SHA-256</span><div class="hash">${escapeHtml(ipogo.sha256)}</div>` : ""}` : `<p class="empty">Package information is temporarily unavailable.</p>`}<details><summary>Other package versions (${remaining.length})</summary><ul class="versions">${remaining.map(({ name, version }) => `<li><span>${escapeHtml(name)}</span><span>${escapeHtml(version)}</span></li>`).join("")}</ul></details></main></body></html>`, {
    headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function upstreamBase(env: Env): string {
  return (env.UPSTREAM_REPO || DEFAULT_UPSTREAM).replace(/\/$/, "");
}

function isAllowedPath(pathname: string): boolean {
  return METADATA_PATHS.includes(pathname) || pathname.startsWith("/debs/");
}

function cacheRequest(pathname: string): Request {
  return new Request(new URL(pathname, "https://mirror-cache.invalid").toString(), { method: "GET" });
}

function cacheable(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  headers.set("X-Repo-Mirror", "cloudflare-worker");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function cacheUpstreamPath(pathname: string, env: Env): Promise<Response> {
  const upstream = new URL(`${upstreamBase(env)}${pathname}`);
  const response = await fetch(upstream, { redirect: "follow" });
  if (!response.ok) throw new Error(`${pathname}: upstream returned ${response.status}`);

  const cached = cacheable(response);
  await edgeCache.put(cacheRequest(pathname), cached.clone());
  return cached;
}

function latestDebPath(packages: string): string | null {
  const records = packages.trim().split(/\n\s*\n/);
  const ipogo = records.filter((record) => /^(?:Package: com\.iteam\.ipogo)$/m.test(record));
  const latest = ipogo.at(-1);
  return latest?.match(/^Filename: \.\/(debs\/[^\r\n]+)$/m)?.[1] ?? null;
}

async function refresh(env: Env): Promise<{ refreshed: string[]; latestDeb: string | null }> {
  const refreshed: string[] = [];
  for (const path of ["/Release", "/Packages", "/Packages.gz", "/Packages.bz2"]) {
    await cacheUpstreamPath(path, env);
    refreshed.push(path);
  }

  const packages = await (await fetch(new URL("Packages", `${upstreamBase(env)}/`))).text();
  const latestDeb = latestDebPath(packages);
  if (latestDeb) {
    await cacheUpstreamPath(`/${latestDeb}`, env);
    refreshed.push(`/${latestDeb}`);
  }
  return { refreshed, latestDeb };
}

async function serveMirror(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (!isAllowedPath(pathname)) return new Response("Not found", { status: 404 });

  const key = cacheRequest(pathname);
  const hit = await edgeCache.match(key);
  if (hit) {
    ctx.waitUntil(cacheUpstreamPath(pathname, env).catch(() => undefined));
    return hit;
  }
  try {
    return await cacheUpstreamPath(pathname, env);
  } catch (error) {
    return new Response(`Upstream unavailable: ${(error as Error).message}`, { status: 502 });
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") return homePage(url.origin, env, ctx);
    if (url.pathname === "/health") return Response.json({ ok: true, upstream: upstreamBase(env) });
    if (url.pathname === "/refresh") {
      if (request.method !== "GET" && request.method !== "POST") return new Response("Use GET or POST /refresh", { status: 405 });
      const expected = env.REFRESH_TOKEN;
      if (expected && request.headers.get("Authorization") !== `Bearer ${expected}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        return Response.json({ ok: true, ...(await refresh(env)) });
      } catch (error) {
        return Response.json({ ok: false, error: (error as Error).message }, { status: 502 });
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    return serveMirror(request, env, ctx);
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(refresh(env));
  },
} satisfies ExportedHandler<Env>;
