import { afterEach, describe, expect, it } from 'vitest';

import { resolveMachineTransferRuntimeConfig } from './transferRuntimeConfig';

describe('resolveMachineTransferRuntimeConfig', () => {
  afterEach(() => {
    delete process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_HOST;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_IDLE_STOP_MS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_ENABLED;
    delete process.env.HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_PATH;
    delete process.env.HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_HTTPS_PORT;
    delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
  });

  it('reads direct-peer and server-routed runtime env from one canonical resolver without widening explicitly configured advertised hosts', () => {
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED = 'true';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED = 'false';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT = '46001';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_IDLE_STOP_MS = '1234';
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '12345';

    const resolved = resolveMachineTransferRuntimeConfig({
      networkInterfacesFn: () => ({
        eth0: [
          { address: '10.0.0.2', family: 'IPv4', internal: false } as never,
        ],
      }),
    });

    expect(resolved.directPeer).toEqual(expect.objectContaining({
      featureEnabled: true,
      serverEnabled: false,
      bindPort: 46001,
      idleStopMs: 1234,
    }));
    expect(resolved.directPeer.advertisedHosts).toEqual(['127.0.0.1']);
    expect(resolved.serverRouted).toEqual(expect.objectContaining({
      timeoutMs: 12345,
    }));
  });

  it('keeps direct-peer server disabled when the feature gate is disabled even if the server env is enabled', () => {
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED = 'false';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED = 'true';

    const resolved = resolveMachineTransferRuntimeConfig({
      networkInterfacesFn: () => ({}),
    });

    expect(resolved.directPeer.featureEnabled).toBe(false);
    expect(resolved.directPeer.serverEnabled).toBe(false);
  });

  it('defaults direct-peer runtime posture to loopback-only even when external NICs exist', () => {
    const resolved = resolveMachineTransferRuntimeConfig({
      networkInterfacesFn: () => ({
        eth0: [
          { address: '10.0.0.2', family: 'IPv4', internal: false } as never,
          { address: '2001:db8::1', family: 'IPv6', internal: false } as never,
        ],
      }),
    });

    expect(resolved.directPeer.bindHost).toBe('127.0.0.1');
    expect(resolved.directPeer.bindPort).toBe(46001);
    expect(resolved.directPeer.advertisedHosts).toEqual(['127.0.0.1']);
    expect(resolved.tailscaleServe).toEqual({
      enabled: false,
      servePath: '/__happier/transfer',
      httpsPort: 443,
    });
  });

  it('clamps legacy local bind and advertisement config to the loopback-only runtime posture', () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_HOST = '0.0.0.0';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '192.168.1.20,10.0.0.8';

    const resolved = resolveMachineTransferRuntimeConfig({
      networkInterfacesFn: () => ({
        eth0: [
          { address: '10.0.0.2', family: 'IPv4', internal: false } as never,
        ],
      }),
    });

    expect(resolved.directPeer.bindHost).toBe('127.0.0.1');
    expect(resolved.directPeer.advertisedHosts).toEqual(['127.0.0.1']);
  });

  it('reads transfer-specific tailscale serve runtime config from the canonical resolver', () => {
    process.env.HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_ENABLED = 'true';
    process.env.HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_PATH = 'machine-transfer';
    process.env.HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_HTTPS_PORT = '8443';

    const resolved = resolveMachineTransferRuntimeConfig({
      networkInterfacesFn: () => ({}),
    });

    expect(resolved.tailscaleServe).toEqual({
      enabled: true,
      servePath: '/machine-transfer',
      httpsPort: 8443,
    });
  });

});
