// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { loadWebBundle } from './web-bundle.mjs';

const browserEntry = '/apps/ui/index.ts.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=.%2Fsources%2Fapp&unstable_transformProfile=hermes-stable';

for (const phase of ['transform-error', 'headers-hang', 'body-hang', 'success', 'cancel']) test(`browser Hermes graph handles ${phase} while the page graph is healthy`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'sentinel-browser-' });
  const requested = Promise.withResolvers();
  const server = createServer((req, res) => {
    if (req.url === '/status') return res.end('packager-status:running');
    if (req.url === '/') return res.end('<script src="/index.bundle?platform=web"></script>');
    if (req.url !== browserEntry) return res.end('/* different graph is healthy */');
    requested.resolve();
    if (phase === 'success') return res.end('/* completed browser bundle */');
    if (phase === 'headers-hang' || phase === 'cancel') return;
    if (phase === 'body-hang') { res.writeHead(200); res.write('/* partial bundle */'); return; }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ filename: 'apps/ui/index.ts', lineNumber: 1 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_STACK: 'main' };
  await mkdir(fixture.path('stacks/main'), { recursive: true });
  await writeFile(fixture.path('stacks/main/stack.runtime.json'), JSON.stringify({ expo: { port: server.address().port, webEnabled: true } }));
  const hangs = phase === 'headers-hang' || phase === 'body-hang';
  if (hangs) t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const pending = loadWebBundle({ repoDir: fixture.root, env, signal: controller.signal });
  if (phase === 'cancel') {
    await requested.promise;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    return;
  }
  if (hangs) {
    // Settle even on the old implementation that requests the wrong graph.
    await Promise.race([requested.promise, pending]);
    t.mock.timers.tick(2 * 8 * 60 * 1000);
  }
  const result = await pending;
  if (phase === 'success') { assert.equal(result.status, 'passed'); return; }
  assert.equal(result.status, 'failed');
  assert.equal(result.loadError.code, phase === 'transform-error' ? 'expo_http_500' : 'expo_bundle_timeout');
});
