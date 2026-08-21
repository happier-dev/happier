import { describe, expect, it } from 'vitest';

import type { TailscaleStatusSnapshot } from '@happier-dev/cli-common/tailscale';

import {
  collectCurrentMachineReachableServerUrlCandidates,
  listCurrentMachineNetworkAddressCandidates,
  tailscaleIpsForReachableCandidates,
} from './currentMachineReachableServerUrlCandidates';

function statusSnapshot(overrides: Partial<TailscaleStatusSnapshot>): TailscaleStatusSnapshot {
  return {
    backendState: 'Running',
    authUrl: null,
    dnsName: 'mac.tailnet.ts.net',
    tailnetName: 'tailnet.ts.net',
    tailscaleIps: ['100.96.55.1'],
    loggedIn: true,
    running: true,
    daemonReachable: true,
    ...overrides,
  };
}

describe('tailscaleIpsForReachableCandidates', () => {
  it('offers tailnet IPs while the backend is running', () => {
    expect(tailscaleIpsForReachableCandidates(statusSnapshot({}))).toEqual(['100.96.55.1']);
  });

  it('offers nothing for a signed-in machine whose backend is stopped', () => {
    // `tailscale status --json` keeps reporting the node's tailnet IPs after
    // `tailscale down`, so `loggedIn` alone would advertise an address that
    // nothing is listening on.
    const status = statusSnapshot({ backendState: 'Stopped', running: false });

    expect(status.loggedIn).toBe(true);
    expect(tailscaleIpsForReachableCandidates(status)).toEqual([]);
  });

  it('offers nothing when the tailscaled daemon never answered', () => {
    expect(tailscaleIpsForReachableCandidates(statusSnapshot({
      backendState: null,
      dnsName: null,
      tailnetName: null,
      tailscaleIps: [],
      loggedIn: false,
      running: false,
      daemonReachable: false,
    }))).toEqual([]);
  });
});

describe('current machine reachable server URL candidates', () => {
  it('prefers Tailscale Serve and only includes probed direct address URLs', async () => {
    const candidates = await collectCurrentMachineReachableServerUrlCandidates({
      localServerUrl: 'http://127.0.0.1:52753',
    }, {
      getNetworkInterfaces: () => ({
        en0: [
          { address: '192.168.1.20', family: 'IPv4', internal: false },
        ],
      }),
      resolveTailscaleServeUrl: async () => 'https://mac.tailnet.ts.net',
      resolveTailscaleIps: async () => ['100.96.55.1'],
      canConnectToTcpEndpoint: async ({ host }) => host === '100.96.55.1',
    });

    expect(candidates.map((candidate) => candidate.url)).toEqual([
      'https://mac.tailnet.ts.net',
      'http://100.96.55.1:52753',
    ]);
    expect(candidates[0]).toMatchObject({
      source: 'tailscale-serve',
      verified: true,
    });
    expect(candidates[1]).toMatchObject({
      source: 'tailscale-ip',
      verified: true,
    });
  });

  it('lists LAN and Tailscale network address candidates while excluding loopback and link-local addresses', () => {
    const candidates = listCurrentMachineNetworkAddressCandidates({
      getNetworkInterfaces: () => ({
        lo0: [
          { address: '127.0.0.1', family: 'IPv4', internal: true },
        ],
        en0: [
          { address: '192.168.1.20', family: 'IPv4', internal: false },
          { address: '169.254.10.20', family: 'IPv4', internal: false },
        ],
        utun5: [
          { address: '100.96.55.1', family: 'IPv4', internal: false },
        ],
      }),
      tailscaleIps: ['100.96.55.1'],
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        address: '100.96.55.1',
        source: 'tailscale-ip',
      }),
      expect.objectContaining({
        address: '192.168.1.20',
        source: 'lan',
      }),
    ]);
  });
});
