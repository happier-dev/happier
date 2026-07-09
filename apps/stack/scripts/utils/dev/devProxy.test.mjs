import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  prepareDevProxyStartup,
  resolveDevProxyStableHost,
  shouldEnableStackDevProxy,
  startDevProxy,
  startDevProxyMaintenanceUpstream,
} from './devProxy.mjs';

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
