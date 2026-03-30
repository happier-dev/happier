import { afterEach, describe, expect, it } from 'vitest';

import { resolveMachineTransferRuntimeConfig } from './transferRuntimeConfig';

describe('resolveMachineTransferRuntimeConfig', () => {
  afterEach(() => {
    delete process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT;
    delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
  });

  it('reads direct-peer and server-routed runtime env from one canonical resolver', () => {
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED = 'true';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED = 'false';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT = '46001';
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
    }));
    expect(resolved.directPeer.advertisedHosts).toEqual(expect.arrayContaining(['127.0.0.1', '10.0.0.2']));
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
});
