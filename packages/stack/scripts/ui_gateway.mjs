import './utils/env/env.mjs';
import http from 'node:http';
import net from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';

function usage() {
  return [
    '[ui-gateway] usage:',
    '  node scripts/ui_gateway.mjs --port=<port> --backend-url=<url> --minio-port=<port> --bucket=<name> [--ui-dir=<path>] [--no-ui]',
    '',
    'Reverse-proxy gateway that can optionally serve the built Happy web UI at /.',
    '',
    'Always proxies:',
    '- /v1/* and /health to backend-url',
    '- /v1/updates websocket upgrades to backend-url (socket.io)',
    '- /files/* to local Minio (http://127.0.0.1:<minio-port>/<bucket>/...)',
  ].join('\n');
}

function normalizePublicPath(path) {
  const p = String(path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = p.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Invalid path');
  }
  if (p.includes(':') || p.startsWith('/')) {
    throw new Error('Invalid path');
  }
  return parts.join('/');
}

function contentTypeForExt(ext) {
  const e = ext.toLowerCase();
  if (e === '.html') return 'text/html; charset=utf-8';
  if (e === '.js') return 'text/javascript; charset=utf-8';
  if (e === '.css') return 'text/css; charset=utf-8';
  if (e === '.json') return 'application/json; charset=utf-8';
  if (e === '.svg') return 'image/svg+xml';
  if (e === '.ico') return 'image/x-icon';
  if (e === '.wasm') return 'application/wasm';
  if (e === '.ttf') return 'font/ttf';
  if (e === '.woff') return 'font/woff';
  if (e === '.woff2') return 'font/woff2';
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

async function sendUiFile({ uiRoot, relPath, res }) {
  const candidate = resolve(uiRoot, relPath);
  if (!(candidate === uiRoot || candidate.startsWith(uiRoot + sep))) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const bytes = await readFile(candidate);
  const ext = extname(candidate);
  const isHtml = ext.toLowerCase() === '.html';
  res.setHeader('content-type', contentTypeForExt(ext));
  if (isHtml) {
    res.setHeader('cache-control', 'no-cache');
  } else {
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  }
  res.end(bytes);
}

async function sendIndex({ uiRoot, res }) {
  const indexPath = resolve(uiRoot, 'index.html');
  const html = (await readFile(indexPath, 'utf-8')) + '\n<!-- Welcome to Happier Server! -->\n';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
}

function proxyHttp({ target, req, res, rewritePath = (p) => p }) {
  const url = new URL(target);
  const method = req.method || 'GET';
  const headers = { ...req.headers };
  // Let Node compute correct host
  delete headers.host;

  const upstream = http.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method,
      path: rewritePath(req.url || '/'),
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad gateway');
  });
  req.pipe(upstream);
}

function proxyUpgrade({ target, req, socket, head }) {
  const url = new URL(target);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

  const upstream = net.connect(port, url.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { ok: true }, text: usage() });
    return;
  }

  const portRaw = (kv.get('--port') ?? '').trim();
  const backendUrl = (kv.get('--backend-url') ?? '').trim();
  const minioPortRaw = (kv.get('--minio-port') ?? '').trim();
  const bucket = (kv.get('--bucket') ?? '').trim();
  const serveUi = !flags.has('--no-ui') && (process.env.HAPPY_LOCAL_SERVE_UI ?? '1') !== '0';
  const uiDir = serveUi ? (kv.get('--ui-dir') ?? '').trim() : '';

  const port = portRaw ? Number(portRaw) : NaN;
  const minioPort = minioPortRaw ? Number(minioPortRaw) : NaN;

  if (!backendUrl || !bucket || !Number.isFinite(port) || port <= 0 || !Number.isFinite(minioPort) || minioPort <= 0) {
    throw new Error(usage());
  }

  const uiRoot = uiDir ? resolve(uiDir) : '';

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url || '/';

      // API + health proxy
      if (url.startsWith('/v1/') || url === '/health' || url === '/metrics' || url.startsWith('/v2/')) {
        proxyHttp({ target: backendUrl, req, res });
        return;
      }

      // Public files proxy (Minio path-style)
      if (url.startsWith('/files/')) {
        proxyHttp({
          target: `http://127.0.0.1:${minioPort}`,
          req,
          res,
          rewritePath: (p) => {
            const raw = p.replace(/^\/files\/?/, '');
            const safe = normalizePublicPath(raw);
            return `/${encodeURIComponent(bucket)}/${safe}`;
          },
        });
        return;
      }

      // UI static
      if (url === '/' || url === '/ui' || url === '/ui/') {
        if (uiRoot) {
          await sendIndex({ uiRoot, res });
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
        res.end('Welcome to Happier Server!');
        return;
      }
      if (url.startsWith('/ui/')) {
        res.writeHead(302, { location: '/' });
        res.end();
        return;
      }

      if (uiRoot) {
        const rel = normalizePublicPath(decodeURIComponent(url));
        const candidate = resolve(uiRoot, rel);
        const exists = candidate === uiRoot || candidate.startsWith(uiRoot + sep) ? await stat(candidate).then(() => true).catch(() => false) : false;
        if (exists) {
          await sendUiFile({ uiRoot, relPath: rel, res });
          return;
        }

        // SPA fallback
        await sendIndex({ uiRoot, res });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = req.url || '';
      // socket.io upgrades for realtime updates
      if (url.startsWith('/v1/updates')) {
        proxyUpgrade({ target: backendUrl, req, socket, head });
        return;
      }
      socket.destroy();
    } catch {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  });

  await new Promise((resolvePromise) => server.listen({ port, host: '0.0.0.0' }, resolvePromise));
  // eslint-disable-next-line no-console
  console.log(`[ui-gateway] ready on http://127.0.0.1:${port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
