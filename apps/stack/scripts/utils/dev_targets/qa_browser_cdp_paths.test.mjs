import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { runQaBrowserSigninPage } from './qa_browser_signin_page.mjs';
import { connectPage } from '../../perf/cdp.mjs';
import { readQaBrowserCdpTargets } from './qa_browser_cdp.mjs';

// Chromium/gateway HTTP is the external boundary; both real consumers run.
for (const prefix of ['', '/browser/owned']) {
  test(`sign-in and perf retain the returned CDP discovery path ${prefix || '/'}`, async t => {
    const paths = [];
    const server = createServer((request, response) => {
      paths.push(request.url);
      response.setHeader('content-type', 'application/json');
      if (request.url !== `${prefix}/json/list`) {
        response.writeHead(409);
        response.end(JSON.stringify({ ok: false, reason: 'qa-browser-custody-lost' }));
      } else response.end('[]');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const endpoint = `http://127.0.0.1:${server.address().port}${prefix}`;
    const result = await runQaBrowserSigninPage({
      cdpHttpUrl: endpoint, key: randomBytes(32).toString('base64url'),
      urls: { uiUrl: 'http://127.0.0.1:3025', canonicalServerUrl: 'http://127.0.0.1:3005' },
    });
    assert.equal(result.reason, 'session_unavailable', 'valid discovery reaches page selection');
    await assert.rejects(connectPage(endpoint), /Select exactly one owned page/);
    assert.deepEqual(paths, [`${prefix}/json/list`, `${prefix}/json/list`]);
  });
}

test('discovered sockets use the controller forward and retain the browser path', async t => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://worker.invalid:9222/browser/owned/devtools/page/page' }]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/browser/owned`;
  const [page] = await readQaBrowserCdpTargets(endpoint);
  assert.equal(page.webSocketDebuggerUrl, `${endpoint.replace('http:', 'ws:')}/devtools/page/page`);
});
