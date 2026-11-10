import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStackInfoSnapshot } from '../../stack/stack_info_snapshot.mjs';
import { resolveVerifiedStackUiEndpoint } from '../stack/verified_endpoints.mjs';
import { looksLikeExpoMetro } from './expo.mjs';
import { withPatchedProcessEnv } from '../../testkit/core/env_scope.mjs';

test('borrowed Expo keeps its URL when HTTP connects but status never responds', async t => {
  withPatchedProcessEnv(t, { HAPPIER_STACK_EXPO_METRO_STATUS_TIMEOUT_MS: '50' });
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
    } else requests += 1;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const endpoint = await resolveVerifiedStackUiEndpoint({
    stackName: 'borrowed-liveness', requireExpoOwnership: false,
    runtimeState: { expo: { webPort: port, webEnabled: true } },
  });
  assert.equal(endpoint.running, true);
  assert.ok(endpoint.url?.endsWith(`:${port}`));
  assert.equal(endpoint.metroStatus, 'busy');
  assert.equal(requests, 1, 'one observation, no retry or secondary probe');
  const storage = await mkdtemp(join(tmpdir(), 'expo-liveness-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storage });
  for (const name of ['liveness-producer', 'liveness-consumer']) {
    await mkdir(join(storage, name));
    await writeFile(join(storage, name, 'env'), `HAPPIER_STACK_RUNTIME_MODE=source\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_SERVER_PORT=${port}\n`
      + (name.endsWith('consumer') ? 'HAPPIER_STACK_EXPO_SOURCE_STACK=liveness-producer\n' : ''));
    await writeFile(join(storage, name, 'stack.runtime.json'), JSON.stringify({
      stackName: name, sourceRuntimeIdentities: {}, processes: {}, ports: { server: port },
      ...(name.endsWith('producer') ? { expo: { webPort: port, webEnabled: true } } : { sourceUi: 'borrowed' }),
    }));
  }
  const info = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: 'liveness-consumer',
    // OS ownership is a boundary; the real HTTP path under test stays intact.
    listListenPidsWithStatusImpl: async () => ({ status: 'ok', supported: true, pids: [process.pid] }),
    isPidOwnedByStackImpl: async () => true,
  });
  assert.equal(info.runtime.borrowedExpo.running, true);
  assert.equal(info.runtime.borrowedExpo.status, 'busy');
  assert.ok(info.urls.uiUrl);
  assert.equal(await looksLikeExpoMetro({ port, timeoutMs: 50, statusOnly: true }), false,
    'readiness must still wait for a response');
});

test('borrowed Expo rejects closed, reset and non-Metro endpoints', async t => {
  withPatchedProcessEnv(t, { HAPPIER_STACK_EXPO_METRO_STATUS_TIMEOUT_MS: '100' });
  for (const mode of ['closed', 'reset', 'other']) {
    const server = createServer((request, response) => {
      if (mode === 'reset') request.socket.destroy();
      else response.end('another service');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    if (mode === 'closed') await new Promise(resolve => server.close(resolve));
    try {
      const endpoint = await resolveVerifiedStackUiEndpoint({
        stackName: 'borrowed-liveness', requireExpoOwnership: false,
        runtimeState: { expo: { webPort: port } },
      });
      assert.equal(endpoint.running, false, mode);
      assert.equal(endpoint.url, null, mode);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
