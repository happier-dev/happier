import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCanonicalBundledPluginArtifactPublisher } from '../../../../cli/scripts/buildSharedDeps.mjs';
import {
  prepareDevProxyStartup,
  resolveDevProxyStableHost,
  shouldEnableStackDevProxy,
  startDevProxy,
  startDevProxyMaintenanceUpstream,
} from './devProxy.mjs';

const PROBE_SCRIPT = String.raw`
const { existsSync, writeFileSync } = await import('node:fs');
const http = await import('node:http');

const [portRaw, readyPath, resultPath, releasePath] = process.argv.slice(1);
const startedAt = Date.now();
while (!existsSync(readyPath)) {
  if (Date.now() - startedAt > 5_000) {
    writeFileSync(resultPath, JSON.stringify({ error: 'publisher did not become ready' }));
    writeFileSync(releasePath, 'release');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

let finished = false;
const finish = (result) => {
  if (finished) return;
  finished = true;
  writeFileSync(resultPath, JSON.stringify(result));
  writeFileSync(releasePath, 'release');
};
const req = http.get({
  host: '127.0.0.1',
  port: Number(portRaw),
  path: '/',
  agent: false,
}, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => finish({ statusCode: res.statusCode, body }));
});
req.setTimeout(2_000, () => req.destroy(new Error('stable proxy response timed out')));
req.on('error', (error) => finish({ error: error.message }));
`;

const PUBLISHER_WRAPPER_SCRIPT = String.raw`
import { spawn } from 'node:child_process';

const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
child.once('error', (error) => {
  console.error(error);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`;

const PENDING_PUBLISHER_SCRIPT = String.raw`
import { existsSync, writeFileSync } from 'node:fs';

const readyPath = process.env.HAPPIER_TEST_PUBLISHER_READY_PATH;
const releasePath = process.env.HAPPIER_TEST_PUBLISHER_RELEASE_PATH;
writeFileSync(readyPath, 'ready');
const startedAt = Date.now();
while (!existsSync(releasePath)) {
  if (Date.now() - startedAt > 5_000) throw new Error('publisher release timed out');
  await new Promise((resolve) => setTimeout(resolve, 10));
}
`;

function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

async function startServer(body) {
  const server = http.createServer((_req, res) => res.end(body));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('stable proxy serves requests while the canonical bundled-plugin publisher is pending', { timeout: 10_000 }, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-pending-plugin-publisher-'));
  const readyPath = join(fixtureRoot, 'publisher.ready');
  const resultPath = join(fixtureRoot, 'proxy-result.json');
  const releasePath = join(fixtureRoot, 'publisher.release');
  const cliScriptsDir = join(fixtureRoot, 'apps', 'cli', 'scripts');
  const generatorDir = join(cliScriptsDir, 'build-owned');
  await mkdir(generatorDir, { recursive: true });
  await writeFile(join(cliScriptsDir, 'withNodeHeapLimit.mjs'), PUBLISHER_WRAPPER_SCRIPT);
  await writeFile(join(generatorDir, 'generateBundledPluginEntries.ts'), PENDING_PUBLISHER_SCRIPT);

  const backend = await startServer('backend');
  const proxy = await startDevProxy({
    stableHost: '127.0.0.1',
    stablePort: 0,
    targetHost: '127.0.0.1',
    targetPort: backend.port,
    label: 'dev-proxy-pending-publisher-test',
  });
  const probe = spawn(
    process.execPath,
    ['--eval', PROBE_SCRIPT, String(proxy.port), readyPath, resultPath, releasePath],
    { stdio: 'inherit' },
  );
  const probeCompletion = new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`proxy probe exited with code=${String(code)} signal=${String(signal)}`));
    });
  });

  try {
    await runCanonicalBundledPluginArtifactPublisher({
      repoRoot: fixtureRoot,
      env: {
        ...process.env,
        HAPPIER_TEST_PUBLISHER_READY_PATH: readyPath,
        HAPPIER_TEST_PUBLISHER_RELEASE_PATH: releasePath,
      },
      quiet: true,
    });
    await probeCompletion;
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.deepEqual(result, { statusCode: 200, body: 'backend' });
  } finally {
    if (probe.exitCode == null && probe.signalCode == null) probe.kill('SIGKILL');
    await probeCompletion.catch(() => {});
    await proxy.stop();
    await backend.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('async canonical bundled-plugin publisher preserves synchronous child failure metadata', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-failing-plugin-publisher-'));
  const cliScriptsDir = join(fixtureRoot, 'apps', 'cli', 'scripts');
  const generatorDir = join(cliScriptsDir, 'build-owned');
  await mkdir(generatorDir, { recursive: true });
  await writeFile(join(cliScriptsDir, 'withNodeHeapLimit.mjs'), PUBLISHER_WRAPPER_SCRIPT);
  await writeFile(join(generatorDir, 'generateBundledPluginEntries.ts'), 'process.exit(23);\n');

  try {
    await assert.rejects(
      () => runCanonicalBundledPluginArtifactPublisher({ repoRoot: fixtureRoot, quiet: true }),
      (error) => {
        assert.match(error.message, /^Command failed: /);
        assert.equal(error.status, 23);
        assert.equal(error.signal, null);
        assert.deepEqual(error.output, [null, null, null]);
        assert.equal(error.stdout, null);
        assert.equal(error.stderr, null);
        assert.ok(Number.isInteger(error.pid) && error.pid > 1);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('dev proxy is default-on with flag and env opt-out', () => {
  assert.equal(shouldEnableStackDevProxy({ startServer: true, flags: new Set(), env: {} }), true);
  assert.equal(shouldEnableStackDevProxy({ startServer: true, flags: new Set(['--no-proxy']), env: {} }), false);
  assert.equal(shouldEnableStackDevProxy({ startServer: true, flags: new Set(), env: { HAPPIER_STACK_DEV_PROXY: '0' } }), false);
  assert.equal(shouldEnableStackDevProxy({ startServer: false, flags: new Set(), env: {} }), false);
});

test('dev proxy stable host preserves direct server reachability unless loopback is requested', () => {
  assert.equal(resolveDevProxyStableHost({ env: {} }), '0.0.0.0');
  assert.equal(resolveDevProxyStableHost({ env: { HAPPIER_STACK_BIND_MODE: 'lan' } }), '0.0.0.0');
  assert.equal(resolveDevProxyStableHost({ env: { HAPPIER_STACK_BIND_MODE: 'loopback' } }), '127.0.0.1');
  assert.equal(resolveDevProxyStableHost({ env: { HOST: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(resolveDevProxyStableHost({ env: { HAPPIER_STACK_DEV_PROXY_HOST: '100.64.0.10' } }), '100.64.0.10');
});

test('proxy flips new HTTP connections to the current backend and can enter maintenance', async () => {
  const first = await startServer('first');
  const second = await startServer('second');
  const proxy = await startDevProxy({
    stableHost: '127.0.0.1',
    stablePort: 0,
    targetHost: '127.0.0.1',
    targetPort: first.port,
    label: 'dev-proxy-test',
  });

  try {
    assert.equal((await request(proxy.port)).body, 'first');
    await proxy.enterMaintenance({ retryAfterMs: 1500, message: 'maintenance' });
    const maintenance = await request(proxy.port);
    assert.equal(maintenance.statusCode, 503);
    assert.equal(maintenance.headers['retry-after'], '2');
    assert.equal(maintenance.body, 'maintenance\n');
    proxy.flipUpstream({ targetPort: second.port });
    assert.equal(proxy.getUpstream().targetPort, second.port);
    assert.equal((await request(proxy.port)).body, 'second');
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
  }
});

test('prepareDevProxyStartup fails closed unless direct fallback bind is safe', async () => {
  const plan = await prepareDevProxyStartup({
    enabled: true,
    stablePort: 4101,
    pickNextFreeTcpPortImpl: async () => 5101,
    startDevProxyImpl: async () => {
      throw new Error('proxy bind failed');
    },
    isTcpPortFreeImpl: async () => true,
  });

  assert.equal(plan.mode, 'directFallback');
  assert.equal(plan.backendPort, 4101);
  assert.match(plan.fallbackReason, /proxy bind failed/);

  await assert.rejects(
    () => prepareDevProxyStartup({
      enabled: true,
      stablePort: 4101,
      pickNextFreeTcpPortImpl: async () => 5101,
      startDevProxyImpl: async () => {
        throw new Error('address in use');
      },
      isTcpPortFreeImpl: async () => false,
    }),
    /address in use/,
  );
});

test('prepareDevProxyStartup separates externally reachable stable bind from backend target', async () => {
  const calls = [];
  const plan = await prepareDevProxyStartup({
    enabled: true,
    stablePort: 4101,
    stableHost: '0.0.0.0',
    targetHost: '127.0.0.1',
    pickNextFreeTcpPortImpl: async (startPort, options) => {
      calls.push(['pick', startPort, options.host]);
      return 5101;
    },
    startDevProxyImpl: async (options) => {
      calls.push(['proxy', options.stableHost, options.stablePort, options.targetHost, options.targetPort]);
      return { pid: 123, port: options.stablePort };
    },
  });

  assert.equal(plan.mode, 'proxy');
  assert.equal(plan.backendPort, 5101);
  assert.deepEqual(calls, [
    ['pick', 4102, '127.0.0.1'],
    ['proxy', '0.0.0.0', 4101, '127.0.0.1', 5101],
  ]);
});

test('maintenance upstream returns stable 503 retry semantics', async () => {
  const upstream = await startDevProxyMaintenanceUpstream({
    host: '127.0.0.1',
    retryAfterMs: 2500,
    message: 'Server reload in progress',
  });

  try {
    const response = await request(upstream.port);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '3');
    assert.equal(response.headers['x-happier-retry-reason'], 'server_restarting');
    assert.equal(response.body, 'Server reload in progress\n');
  } finally {
    await upstream.stop();
  }
});

test('terminal maintenance is distinguishable from transient retry maintenance', async () => {
  const upstream = await startDevProxyMaintenanceUpstream({
    host: '127.0.0.1',
    port: 0,
    retryAfterMs: 1000,
    message: 'retrying',
  });
  try {
    upstream.update({ retryable: false, message: 'Server unavailable; edit or restart the stack.' });
    const response = await request(upstream.port);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], undefined);
    assert.equal(response.headers['x-happier-retry-reason'], 'server_unavailable');
    assert.match(response.body, /Server unavailable/);
  } finally {
    await upstream.stop();
  }
});
