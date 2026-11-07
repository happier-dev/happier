import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { openQaBrowserCdpEndpoint, readQaBrowserCdpTargets } from './qa_browser_cdp.mjs';
import { runQaBrowserSigninPage } from './qa_browser_signin_page.mjs';

// This loopback server is Chromium's external HTTP/WebSocket boundary.
async function chromium(t, browserId) {
  let requests = 0;
  const debuggerPath = `/devtools/browser/${browserId}`;
  const sockets = new Set();
  const server = createServer((request, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    const webSocketDebuggerUrl = `ws://127.0.0.1:${server.address().port}${debuggerPath}`;
    response.end(JSON.stringify(request.url === '/json/list'
      ? [{ id: 'page', type: 'page', webSocketDebuggerUrl: webSocketDebuggerUrl.replace('/browser/', '/page/') }]
      : { webSocketDebuggerUrl }));
  });
  server.on('upgrade', (request, socket) => {
    requests++;
    assert.ok(request.url.startsWith('/devtools/'));
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const message = Buffer.from(browserId);
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
    socket.on('data', () => socket.end(Buffer.from([0x88, 0])));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { forwardPort: server.address().port, debuggerPath, requests: () => requests };
}

test('the browser endpoint refuses stale HTTP and WebSocket attaches after launcher port reuse', async t => {
  const first = await chromium(t, 'first');
  const original = await openQaBrowserCdpEndpoint({ ...first, listenPort: 0 });
  const { port } = new URL(original.cdpHttpUrl);
  await original.close(); // Launcher ends and its listener becomes reusable.
  const second = await chromium(t, 'second');
  const replacement = await openQaBrowserCdpEndpoint({ ...second, listenPort: Number(port) });
  t.after(() => replacement.close());
  replacement.resume();

  const stale = await fetch(`${original.cdpHttpUrl}/json/version`);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { ok: false, reason: 'qa-browser-custody-lost' });
  await assert.rejects(readQaBrowserCdpTargets(original.cdpHttpUrl), { code: 'qa-browser-custody-lost' });
  const signin = await runQaBrowserSigninPage({
    urls: { uiUrl: 'http://127.0.0.1:3025', canonicalServerUrl: 'http://127.0.0.1:3005' },
    cdpHttpUrl: original.cdpHttpUrl, key: randomBytes(32).toString('base64url'),
  });
  assert.deepEqual(signin, { ok: false, reason: 'qa-browser-custody-lost' });
  const wrongSocket = new WebSocket(original.cdpUrl);
  await once(wrongSocket, 'error');
  assert.equal(second.requests(), 0, 'stale attaches must not reach the replacement browser');

  const version = await (await fetch(`${replacement.cdpHttpUrl}/json/version`)).json();
  assert.equal(second.requests(), 1, 'one admitted discovery performs one upstream request');
  assert.equal(version.webSocketDebuggerUrl, replacement.cdpUrl);
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const [message] = await once(socket, 'message');
  assert.equal(message.data, 'second', 'the legitimate owner can attach over the same reused listener');
  socket.close();
  await once(socket, 'close');
  const pages = await readQaBrowserCdpTargets(replacement.cdpHttpUrl);
  assert.ok(pages[0].webSocketDebuggerUrl.startsWith(replacement.cdpUrl.replace('/devtools/browser/second', '/devtools/page/')));
  const trailingSlashVersion = await (await fetch(`${replacement.cdpHttpUrl}/json/version/`)).json();
  assert.equal(trailingSlashVersion.webSocketDebuggerUrl, replacement.cdpUrl);
});

test('forward loss suspends discovery and existing sockets until the owner restores the forward', async t => {
  const browser = await chromium(t, 'owned');
  const endpoint = await openQaBrowserCdpEndpoint({ ...browser, listenPort: 0 });
  t.after(() => endpoint.close());
  endpoint.resume();
  const socket = new WebSocket(endpoint.cdpUrl);
  await once(socket, 'message');
  const closed = once(socket, 'close');
  endpoint.suspend();
  await closed;
  const before = browser.requests();
  const unavailable = await fetch(`${endpoint.cdpHttpUrl}/json/version`);
  assert.equal(unavailable.status, 503);
  assert.equal(browser.requests(), before, 'a suspended endpoint must do no discovery against the released SSH port');
  endpoint.resume();
  assert.equal((await fetch(`${endpoint.cdpHttpUrl}/json/version`)).status, 200);
});
