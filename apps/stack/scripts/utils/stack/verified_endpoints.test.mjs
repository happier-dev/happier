import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStackFixtureEnv, withPatchedProcessEnv } from '../../testkit/core/env_scope.mjs';
import { readStackInfoSnapshot } from '../../stack/stack_info_snapshot.mjs';

import {
  resolveVerifiedStackServerEndpoint,
  resolveVerifiedStackUiEndpoint,
} from './verified_endpoints.mjs';

async function spawnMetroLikeServer({ projectDir, stackName, envPath, stalled = false }) {
  const script = `
    const http = require('http');
    const projectDir = process.argv[2] || '';
    const srv = http.createServer((req, res) => {
      if (req.url === '/status') {
        if (process.env.TEST_METRO_STALLED === '1') return;
        res.statusCode = 200;
        res.setHeader('x-react-native-project-root', projectDir);
        res.end('packager-status:running');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><body><div id="root"></div></body></html>');
    });
    srv.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ port: srv.address().port, pid: process.pid }));
    });
    setInterval(() => {}, 1000);
  `.trim();
  const child = spawn(process.execPath, ['-e', script, projectDir], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: buildStackFixtureEnv({ stripStackEnv: true, stackName, envPath,
      extraEnv: { TEST_METRO_STALLED: stalled ? '1' : '0' } }),
  });
  const line = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) resolve(buffer.slice(0, newline));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`metro-like test server exited before ready (code=${code ?? 'unknown'})`)));
  });
  const meta = JSON.parse(String(line ?? '').trim());
  return {
    pid: Number(meta.pid),
    port: Number(meta.port),
    async close() {
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort
      }
    },
  };
}

test('runtime-selected Expo preserves producer and borrowed liveness while status stalls', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'hstack-stalled-expo-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: temp,
    HAPPIER_STACK_EXPO_METRO_STATUS_TIMEOUT_MS: '25' });
  const producer = 'stalled-expo-producer';
  const consumer = 'stalled-expo-consumer';
  const baseDir = join(temp, producer);
  await mkdir(baseDir);
  await mkdir(join(temp, consumer));
  await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source\nHAPPIER_STACK_DAEMON=0\n');
  await writeFile(join(temp, consumer, 'env'), `HAPPIER_STACK_RUNTIME_MODE=source\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_EXPO_SOURCE_STACK=${producer}\n`);
  const metro = await spawnMetroLikeServer({ projectDir: temp, stackName: producer,
    envPath: join(baseDir, 'env'), stalled: true });
  t.after(() => metro.close());
  await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify({
    stackName: producer, script: 'dev.mjs', sourceRuntimeIdentities: {},
    expo: { webPort: metro.port, webEnabled: true }, processes: { expoPid: metro.pid },
  }));
  await writeFile(join(temp, consumer, 'stack.runtime.json'), JSON.stringify({
    stackName: consumer, sourceUi: 'borrowed', sourceRuntimeIdentities: {}, processes: {},
  }));
  for (const stackName of [producer, consumer]) {
    const info = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(info.runtime.components.ui.running, true, `${stackName}: HTTP slowness is not process absence`);
    assert.equal(info.ports.ui, metro.port);
    // A borrowed URL also needs a live consumer server; that complete fixture
    // is covered in expo_liveness.test.mjs. This fixture has only Metro.
    if (stackName === producer) assert.ok(info.urls.uiUrl);
  }
  const unrelated = await resolveVerifiedStackUiEndpoint({ stackName: 'other-stack', baseDir,
    runtimeState: { expo: { webPort: metro.port }, processes: { expoPid: metro.pid } },
    requireExpoOwnership: false });
  assert.equal(unrelated.running, true, 'the recorded endpoint uses HTTP without a wrapper-PID veto');
  assert.equal(unrelated.metroStatus, 'busy');
});

test('resolveVerifiedStackServerEndpoint does not verify an arbitrary listener as a Happier server', async () => {
  const endpoint = await resolveVerifiedStackServerEndpoint(
    { port: 53288, host: '127.0.0.1' },
    {
      isTcpPortListeningImpl: async () => true,
      fetchHappierHealthImpl: async () => null,
    },
  );

  assert.equal(endpoint.running, false);
  assert.equal(endpoint.port, 53288);
  assert.equal(endpoint.url, 'http://127.0.0.1:53288');
  assert.equal(endpoint.health, null);
  assert.equal(endpoint.portListening, true);
});

test('resolveVerifiedStackUiEndpoint does not surface a web UI when UI serving is disabled', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'hstack-verified-ui-disabled-'));
  const baseDir = join(temp, 'stack');
  const projectDir = join(temp, 'ui-project');
  const metro = await spawnMetroLikeServer({ projectDir });

  try {
    await mkdir(join(baseDir, 'expo-dev', 'abc123'), { recursive: true });
    await writeFile(
      join(baseDir, 'expo-dev', 'abc123', 'expo.state.json'),
      JSON.stringify({
        pid: metro.pid,
        port: metro.port,
        projectDir,
        webEnabled: true,
      }) + '\n',
      'utf8',
    );

    const endpoint = await resolveVerifiedStackUiEndpoint({
      stackName: 'test-stack',
      baseDir,
      runtimeState: { expo: { webPort: metro.port, webEnabled: true } },
      expectedProjectDir: projectDir,
      serveUiWanted: false,
    });

    assert.equal(endpoint.expected, false);
    assert.equal(endpoint.running, false);
    assert.equal(endpoint.port, null);
    assert.equal(endpoint.url, null);
    assert.equal(endpoint.source, 'disabled');
  } finally {
    await metro.close();
    await rm(temp, { recursive: true, force: true });
  }
});
