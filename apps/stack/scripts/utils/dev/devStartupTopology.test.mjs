import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideDevStartupTopology,
  observeDevServerStartupTopology,
  shouldExitAdoptedDevRuntime,
} from './devStartupTopology.mjs';

test('an explicit watch keeps the dev lifecycle owner alive after adopting healthy components', () => {
  const adopted = {
    devTargetCount: 0,
    restart: false,
    serverRequested: false,
    adoptedServer: false,
    daemonRequested: true,
    daemonRunning: true,
    expoRequested: false,
    expoRunning: false,
  };

  assert.equal(shouldExitAdoptedDevRuntime({ ...adopted, watchEnabled: false }), true);
  assert.equal(shouldExitAdoptedDevRuntime({ ...adopted, watchEnabled: true }), false);
});

test('startup topology observes occupied ownership independently of application health', async () => {
  let availabilityOptions = null;
  const topology = await observeDevServerStartupTopology({
    serverRequested: true, stackMode: true, serverPort: 45678,
  }, {
    observeTcpPortAvailabilityImpl: async (_port, options) => {
      availabilityOptions = options;
      return { status: 'occupied' };
    },
    observeRuntimePortOwnedByStackDevProxyImpl: async () => false,
    resolveStackOwnedServerListenPidImpl: async () => null,
  });
  assert.equal(topology.topology, 'foreign');
  assert.equal(topology.proxyOwned, false);
  assert.equal(availabilityOptions?.timeoutMs, 3_000);
});

test('stackless startup adopts a healthy occupied Happier endpoint without claiming ownership', async () => {
  const topology = await observeDevServerStartupTopology({
    serverRequested: true,
    stackMode: false,
    serverPort: 45678,
    serverHealthObservation: { ok: true, status: 200 },
  }, {
    observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied' }),
  });

  assert.equal(topology.topology, 'healthy-unowned');
  assert.equal(topology.proxyOwned, false);
  assert.deepEqual(decideDevStartupTopology({
    serverRequested: true,
    serverTopology: topology.topology,
  }), {
    serverTopology: 'healthy-unowned',
    startServer: false,
    startDaemon: false,
    startExpo: false,
    adoptedServer: true,
  });
});

test('stackless startup rejects an unhealthy occupied endpoint as foreign', async () => {
  const topology = await observeDevServerStartupTopology({
    serverRequested: true,
    stackMode: false,
    serverPort: 45678,
    serverHealthObservation: { ok: false, status: 503 },
  }, {
    observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied' }),
  });

  assert.equal(topology.topology, 'foreign');
  assert.throws(
    () => decideDevStartupTopology({ serverRequested: true, serverTopology: topology.topology }),
    (error) => error?.code === 'ESERVERTOPOLOGYFOREIGN',
  );
});

test('stackless startup fails closed when occupied endpoint health is inconclusive', async () => {
  const topology = await observeDevServerStartupTopology({
    serverRequested: true,
    stackMode: false,
    serverPort: 45678,
    serverHealthObservation: { ok: false, status: null },
  }, {
    observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied' }),
  });

  assert.equal(topology.topology, 'inconclusive');
  assert.throws(
    () => decideDevStartupTopology({ serverRequested: true, serverTopology: topology.topology }),
    (error) => error?.code === 'ESERVERTOPOLOGYINCONCLUSIVE',
  );
});

test('stackless restart never treats a healthy unowned endpoint as killable', () => {
  assert.throws(
    () => decideDevStartupTopology({
      serverRequested: true,
      serverTopology: 'healthy-unowned',
      restart: true,
    }),
    (error) => error?.code === 'ESERVERTOPOLOGYUNOWNED',
  );
});

test('stack ownership without a direct-server role projection is inconclusive', async () => {
  const topology = await observeDevServerStartupTopology({
    serverRequested: true, stackMode: true, serverPort: 45678,
  }, {
    observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied' }),
    observeRuntimePortOwnedByStackDevProxyImpl: async () => ({ owned: false, proxyPid: null, listenerPid: null }),
    resolveStackOwnedServerListenPidImpl: async () => 4321,
  });

  assert.equal(topology.topology, 'inconclusive');
  assert.equal(topology.listenerPid, 4321);
});

test('a stack-owned listener matching the projected proxy pid is proven proxy despite stale proxy metadata', async () => {
  const topology = await observeDevServerStartupTopology({
    serverRequested: true, stackMode: true, serverPort: 45678,
  }, {
    observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied' }),
    observeRuntimePortOwnedByStackDevProxyImpl: async () => ({ owned: false, proxyPid: 4321, listenerPid: null }),
    resolveStackOwnedServerListenPidImpl: async () => 4321,
  });

  assert.equal(topology.topology, 'exact-owned-proxy');
  assert.equal(topology.proxyOwned, true);
  assert.equal(topology.listenerPid, 4321);
});

test('a stack-owned listener matching only the projected server pid is proven direct', async () => {
  const topology = await observeDevServerStartupTopology({
    serverRequested: true, stackMode: true, serverPort: 45678,
  }, {
    observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied' }),
    observeRuntimePortOwnedByStackDevProxyImpl: async () => ({
      owned: false, proxyPid: null, serverPid: 4321, listenerPid: 4321,
    }),
    resolveStackOwnedServerListenPidImpl: async () => assert.fail('listener evidence should be reused'),
  });

  assert.equal(topology.topology, 'exact-owned-direct');
  assert.equal(topology.proxyOwned, false);
  assert.equal(topology.listenerPid, 4321);
});

for (const serverTopology of ['exact-owned-direct', 'exact-owned-proxy']) {
  test(`${serverTopology} adoption starts only missing requested components`, () => {
    assert.deepEqual(decideDevStartupTopology({
      serverRequested: true,
      serverTopology,
      daemonRequested: true,
      daemonRunning: false,
      expoRequested: true,
      expoRunning: true,
    }), {
      serverTopology,
      startServer: false,
      startDaemon: true,
      startExpo: false,
      adoptedServer: true,
    });
  });
}

for (const serverTopology of ['foreign', 'inconclusive']) {
  test(`${serverTopology} topology fails before callers can perform startup side effects`, () => {
    assert.throws(
      () => decideDevStartupTopology({ serverRequested: true, serverTopology }),
      (error) => error?.code === (serverTopology === 'foreign' ? 'ESERVERTOPOLOGYFOREIGN' : 'ESERVERTOPOLOGYINCONCLUSIVE'),
    );
  });
}
