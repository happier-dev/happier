import test from 'node:test';
import assert from 'node:assert/strict';

import * as firstPartyRuntime from '../src/firstPartyRuntime/relayRuntime.ts';

test('relay runtime status normalization understands systemd active+enabled states', () => {
  assert.equal(typeof firstPartyRuntime.normalizeRelayRuntimeStatus, 'function');

  const status = firstPartyRuntime.normalizeRelayRuntimeStatus({
    installVersion: '1.2.3',
    service: {
      backend: 'systemd-user',
      raw: {
        unitFileState: 'enabled',
        activeState: 'active',
        subState: 'running',
      },
    },
    health: {
      portOpen: true,
      pingOk: true,
      url: 'http://127.0.0.1:3005/v1/version',
    },
  });

  assert.equal(status.installed, true);
  assert.equal(status.version, '1.2.3');
  assert.equal(status.service.enabled, true);
  assert.equal(status.service.active, true);
  assert.equal(status.health.reachable, true);
});

test('relay runtime status normalization reads Windows scheduled-task state', () => {
  assert.equal(typeof firstPartyRuntime.normalizeRelayRuntimeStatus, 'function');

  const status = firstPartyRuntime.normalizeRelayRuntimeStatus({
    installVersion: '1.2.3',
    service: {
      backend: 'schtasks-user',
      raw: {
        exists: true,
        enabled: true,
        active: true,
        stateLabel: 'Running',
      },
    },
    health: {
      portOpen: true,
      pingOk: true,
      url: 'http://127.0.0.1:3005/v1/version',
    },
  });

  assert.equal(status.service.installed, true);
  assert.equal(status.service.enabled, true);
  assert.equal(status.service.active, true);
  assert.equal(status.service.stateLabel, 'Running');
});

test('relay runtime health check requires an ok JSON payload from the version endpoint', async () => {
  assert.equal(typeof firstPartyRuntime.checkRelayRuntimeHealth, 'function');

  const healthy = await firstPartyRuntime.checkRelayRuntimeHealth({
    host: '127.0.0.1',
    port: 4040,
    timeoutMs: 5_000,
    probePortOpen: async ({ host, port, timeoutMs }) => {
      assert.equal(host, '127.0.0.1');
      assert.equal(port, 4040);
      assert.equal(timeoutMs, 5_000);
      return true;
    },
    fetchJson: async ({ url, timeoutMs }) => {
      assert.equal(url, 'http://127.0.0.1:4040/v1/version');
      assert.equal(timeoutMs, 5_000);
      return {
        ok: true,
        status: 200,
        body: { version: '1.2.3' },
      };
    },
  });

  assert.deepEqual(healthy, {
    reachable: true,
    portOpen: true,
    pingOk: true,
    url: 'http://127.0.0.1:4040/v1/version',
    statusCode: 200,
    version: '1.2.3',
  });
});

test('relay runtime defaults resolve stable system install paths on Linux', () => {
  assert.equal(typeof firstPartyRuntime.resolveRelayRuntimeDefaults, 'function');

  const defaults = firstPartyRuntime.resolveRelayRuntimeDefaults({
    platform: 'linux',
    mode: 'system',
    channel: 'stable',
    homeDir: '/Users/example',
  });

  assert.equal(defaults.installRoot, '/opt/happier');
  assert.equal(defaults.binDir, '/usr/local/bin');
  assert.equal(defaults.configDir, '/etc/happier');
  assert.equal(defaults.dataDir, '/var/lib/happier');
  assert.equal(defaults.logDir, '/var/log/happier');
  assert.equal(defaults.serviceName, 'happier-server');
  assert.equal(defaults.serverHost, '127.0.0.1');
  assert.equal(defaults.serverPort, 3005);
  assert.equal(defaults.healthPath, '/v1/version');
});
