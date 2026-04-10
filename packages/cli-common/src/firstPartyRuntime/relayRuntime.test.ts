import { describe, expect, it, vi } from 'vitest';

import {
  checkRelayRuntimeHealth,
  normalizeRelayRuntimeStatus,
  resolveRelayRuntimeDefaults,
} from './relayRuntime';

describe('resolveRelayRuntimeDefaults', () => {
  it('returns cross-platform install roots and service labels for user mode', () => {
    expect(resolveRelayRuntimeDefaults({
      platform: 'darwin',
      mode: 'user',
      channel: 'stable',
      homeDir: '/Users/alex',
    })).toMatchObject({
      installRoot: '/Users/alex/.happier/self-host',
      configDir: '/Users/alex/.happier/self-host/config',
      dataDir: '/Users/alex/.happier/self-host/data',
      logDir: '/Users/alex/.happier/self-host/logs',
      serviceName: 'happier-server',
      serverPort: 3005,
    });

    expect(resolveRelayRuntimeDefaults({
      platform: 'win32',
      mode: 'user',
      channel: 'preview',
      homeDir: 'C:\\Users\\alex',
    })).toMatchObject({
      installRoot: 'C:\\Users\\alex\\.happier\\self-host-preview',
      binDir: 'C:\\Users\\alex\\.happier\\bin',
      serviceName: 'happier-server-preview',
      serverPort: 3005,
    });
  });

  it('returns system-mode locations without depending on a home directory', () => {
    expect(resolveRelayRuntimeDefaults({
      platform: 'linux',
      mode: 'system',
      channel: 'publicdev',
      homeDir: '/ignored',
    })).toMatchObject({
      installRoot: '/opt/happier-dev',
      configDir: '/etc/happier-dev',
      dataDir: '/var/lib/happier-dev',
      logDir: '/var/log/happier-dev',
      serviceName: 'happier-server-dev',
      serverPort: 3005,
    });
  });
});

describe('normalizeRelayRuntimeStatus', () => {
  it('normalizes platform-specific service reports into a stable status model', () => {
    expect(normalizeRelayRuntimeStatus({
      platform: 'linux',
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
        url: 'http://127.0.0.1:3005/health',
      },
    })).toEqual({
      installed: true,
      version: '1.2.3',
      service: {
        backend: 'systemd-user',
        installed: true,
        enabled: true,
        active: true,
        stateLabel: 'running',
      },
      health: {
        reachable: true,
        portOpen: true,
        pingOk: true,
        url: 'http://127.0.0.1:3005/health',
      },
    });

    expect(normalizeRelayRuntimeStatus({
      platform: 'win32',
      installVersion: null,
      service: {
        backend: 'schtasks-user',
        raw: {
          exists: false,
        },
      },
      health: {
        portOpen: false,
        pingOk: false,
        url: 'http://127.0.0.1:3005/health',
      },
    })).toEqual({
      installed: false,
      version: null,
      service: {
        backend: 'schtasks-user',
        installed: false,
        enabled: false,
        active: false,
        stateLabel: 'not_installed',
      },
      health: {
        reachable: false,
        portOpen: false,
        pingOk: false,
        url: 'http://127.0.0.1:3005/health',
      },
    });
  });
});

describe('checkRelayRuntimeHealth', () => {
  it('defaults to the /health path when probing the runtime', async () => {
    await expect(checkRelayRuntimeHealth({
      host: '127.0.0.1',
      port: 3005,
      timeoutMs: 5_000,
      probePortOpen: async () => true,
      fetchJson: async ({ url }) => {
        expect(url).toBe('http://127.0.0.1:3005/health');
        return { ok: true, status: 200, body: { status: 'ok' } };
      },
    })).resolves.toMatchObject({
      reachable: true,
      url: 'http://127.0.0.1:3005/health',
    });
  });

  it('requires both the port probe and the app ping to succeed', async () => {
    await expect(checkRelayRuntimeHealth({
      host: '127.0.0.1',
      port: 3005,
      path: '/health',
      timeoutMs: 5_000,
      probePortOpen: async () => true,
      fetchJson: async () => ({ ok: true, status: 200, body: { version: '1.2.3' } }),
    })).resolves.toEqual({
      reachable: true,
      portOpen: true,
      pingOk: true,
      url: 'http://127.0.0.1:3005/health',
      statusCode: 200,
      version: '1.2.3',
    });

    await expect(checkRelayRuntimeHealth({
      host: '127.0.0.1',
      port: 3005,
      path: '/health',
      timeoutMs: 1,
      probePortOpen: async () => true,
      fetchJson: async () => ({ ok: false, status: 503, body: null }),
    })).resolves.toEqual({
      reachable: false,
      portOpen: true,
      pingOk: false,
      url: 'http://127.0.0.1:3005/health',
      statusCode: 503,
      version: null,
    });
  });

  it('retries until the runtime becomes reachable within the timeout window', async () => {
    vi.useFakeTimers();
    try {
      let probeAttempts = 0;
      const healthPromise = checkRelayRuntimeHealth({
        host: '127.0.0.1',
        port: 3005,
        path: '/health',
        timeoutMs: 1_000,
        probePortOpen: async () => {
          probeAttempts += 1;
          return probeAttempts >= 3;
        },
        fetchJson: async () => ({ ok: true, status: 200, body: { version: '1.2.3' } }),
      });

      await vi.runAllTimersAsync();
      await expect(healthPromise).resolves.toMatchObject({
        reachable: true,
        pingOk: true,
      });
      expect(probeAttempts).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
