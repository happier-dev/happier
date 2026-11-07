import { createServer, request as requestHttp, ServerResponse } from 'node:http';
export const QA_BROWSER_CUSTODY_LOST = 'qa-browser-custody-lost';
export const QA_BROWSER_CDP_UNAVAILABLE = 'qa-browser-cdp-unavailable';

// CDP discovery belongs below the complete endpoint returned by its owner.
export async function readQaBrowserCdpTargets(endpoint, { fetchImpl = fetch, signal } = {}) {
  const base = new URL(endpoint);
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  const response = await fetchImpl(new URL('json/list', base), { signal });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const code = result?.reason === QA_BROWSER_CUSTODY_LOST
      ? QA_BROWSER_CUSTODY_LOST : QA_BROWSER_CDP_UNAVAILABLE;
    throw Object.assign(new Error(`[dev-targets] CDP discovery HTTP ${response.status}`),
      { code, status: response.status });
  }
  return (await response.json()).map(target => {
    if (!target.webSocketDebuggerUrl) return target;
    const address = new URL(target.webSocketDebuggerUrl, base);
    address.host = base.host;
    address.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return { ...target, webSocketDebuggerUrl: address.href };
  });
}

function custodyLost() {
  return Object.assign(new Error('[dev-targets] QA browser custody lost; acquire a new browser'), { code: QA_BROWSER_CUSTODY_LOST });
}


// The public listener carries Chromium's existing browser identity. A later
// launcher can reuse its port, but cannot accept a prior browser's URL.
export async function openQaBrowserCdpEndpoint({ listenPort, forwardPort, debuggerPath }) {
  const prefix = `/browser/${debuggerPath.slice('/devtools/browser/'.length)}`;
  const sockets = new Set();
  let available = false;
  let origin;
  const track = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const refusal = (path, response) => {
    const reason = !path.startsWith(`${prefix}/`) ? QA_BROWSER_CUSTODY_LOST
      : !available ? QA_BROWSER_CDP_UNAVAILABLE : null;
    if (!reason) return false;
    response.writeHead(reason === QA_BROWSER_CUSTODY_LOST ? 409 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, reason }));
    return true;
  };
  const server = createServer((incoming, outgoing) => {
    if (refusal(incoming.url, outgoing)) return;
    const path = incoming.url.slice(prefix.length);
    const upstream = requestHttp({ hostname: '127.0.0.1', port: forwardPort, path,
      method: incoming.method, headers: { ...incoming.headers, host: `127.0.0.1:${forwardPort}` }, agent: false }, response => {
      if (!['/json', '/json/list', '/json/version'].includes(path.split('?')[0].replace(/\/$/, ''))) {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', () => outgoing.destroy());
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const project = value => {
            if (typeof value.webSocketDebuggerUrl !== 'string') return value;
            const endpoint = new URL(value.webSocketDebuggerUrl);
            return { ...value, webSocketDebuggerUrl: `${origin.replace('http:', 'ws:')}${prefix}${endpoint.pathname}${endpoint.search}` };
          };
          outgoing.writeHead(response.statusCode, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify(Array.isArray(data) ? data.map(project) : project(data)));
        } catch { outgoing.writeHead(502); outgoing.end(); }
      });
    });
    upstream.on('socket', track);
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ ok: false, reason: QA_BROWSER_CDP_UNAVAILABLE }));
    });
    incoming.pipe(upstream);
  });
  server.on('connection', track);
  server.on('upgrade', (incoming, socket, head) => {
    // ServerResponse also formats an ordinary refusal for an upgrade request.
    const response = new ServerResponse(incoming);
    response.assignSocket(socket);
    if (refusal(incoming.url, response)) return;
    response.detachSocket(socket);
    const upstream = requestHttp({ hostname: '127.0.0.1', port: forwardPort,
      path: incoming.url.slice(prefix.length), headers: { ...incoming.headers, host: `127.0.0.1:${forwardPort}` }, agent: false });
    upstream.on('socket', track);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} CDP unavailable\r\nConnection: close\r\n\r\n`); });
    upstream.on('upgrade', (response, peer, peerHead) => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
      peer.on('error', () => socket.destroy());
      socket.once('close', () => peer.destroy());
      peer.once('close', () => socket.destroy());
      if (head.length) peer.write(head);
      if (peerHead.length) socket.write(peerHead);
      socket.pipe(peer).pipe(socket);
    });
    upstream.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const suspend = () => {
    available = false;
    for (const socket of sockets) socket.destroy();
  };
  return {
    cdpHttpUrl: `${origin}${prefix}`,
    cdpUrl: `${origin.replace('http:', 'ws:')}${prefix}${debuggerPath}`,
    verifyBrowser: endpoint => {
      if (new URL(endpoint).pathname !== debuggerPath) {
        throw custodyLost();
      }
    },
    suspend,
    resume: () => { available = true; },
    close: async () => { suspend(); await new Promise(resolve => server.close(resolve)); },
  };
}
