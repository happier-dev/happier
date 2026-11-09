import { describe, expect, it } from 'vitest';

import {
  isTailscaleDaemonUnreachableOutput,
  parseTailscaleStatusSnapshot,
  tailscaleStatusSnapshotForUnreachableDaemon,
} from './statusSnapshot.js';

const nodeIdentity = {
  Self: { DNSName: 'my-machine.tailnet.ts.net.' },
  CurrentTailnet: { Name: 'tailnet.ts.net' },
  TailscaleIPs: ['100.64.0.10'],
  HaveNodeKey: true,
};

describe('parseTailscaleStatusSnapshot', () => {
  it.each([true, false, undefined, 'true'])('keeps MagicDNS %s distinct from unknown', (value) => {
    expect(parseTailscaleStatusSnapshot({
      ...nodeIdentity,
      BackendState: 'Running',
      CurrentTailnet: { Name: 'tailnet.ts.net', MagicDNSEnabled: value },
    })).toMatchObject({ magicDnsEnabled: typeof value === 'boolean' ? value : null });
  });

  it('matches equivalent IPv6 spelling while ignoring invalid and scoped addresses', () => {
    const snapshot = parseTailscaleStatusSnapshot({
      ...nodeIdentity, BackendState: 'Running', TUN: true, TailscaleIPs: ['FD7A:115C:A1E0:0:0:0:0:1234', 'not-an-ip'],
    }, {
      utun9: [{ address: 'fd7a:115c:a1e0::1234', family: 'IPv6', internal: false }],
      invalid: [
        { address: 'not-an-ip', family: 'IPv4', internal: false },
        { address: 'fe80::1%eth0', family: 'IPv6', internal: false },
      ],
    });
    expect(snapshot).toMatchObject({ interfaceName: 'utun9', sourceRanges: ['fd7a:115c:a1e0::/48'] });
  });

  it('uses the observed interface and matching address families, never the interface name', () => {
    const interfaces = {
      eth0: [{ address: '192.0.2.4', family: 'IPv4' as const, internal: false }],
      'private-overlay-7': [
        { address: '100.64.0.10', family: 'IPv4' as const, internal: false },
        { address: 'fd7a:115c:a1e0::1234', family: 'IPv6' as const, internal: false },
      ],
    };
    expect(parseTailscaleStatusSnapshot({
      ...nodeIdentity, BackendState: 'Running', TUN: true,
      TailscaleIPs: ['100.64.0.10', 'fd7a:115c:a1e0::1234'],
    }, interfaces)).toMatchObject({
      interfaceName: 'private-overlay-7',
      sourceRanges: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'],
    });
    expect(parseTailscaleStatusSnapshot({
      ...nodeIdentity, BackendState: 'Running', TUN: true,
    }, interfaces)).toMatchObject({ interfaceName: 'private-overlay-7', sourceRanges: ['100.64.0.0/10'] });
  });

  it.each([
    { BackendState: 'Running', TUN: false },
    { BackendState: 'Stopped', TUN: true },
    { BackendState: 'NeedsMachineAuth', TUN: true },
  ])('keeps native scope unavailable for %s despite retained membership addresses', (state) => {
    expect(parseTailscaleStatusSnapshot({ ...nodeIdentity, ...state }, {
      tailscale0: [{ address: '100.64.0.10', family: 'IPv4', internal: false }],
    })).toMatchObject({ interfaceName: null, sourceRanges: [] });
  });

  it('never infers native scope from a conventional name, loopback or ambiguous interfaces', () => {
    for (const interfaces of [
      {},
      { tailscale0: [{ address: '192.0.2.4', family: 'IPv4' as const, internal: false }] },
      { loop: [{ address: '100.64.0.10', family: 'IPv4' as const, internal: true }] },
      {
        overlayA: [{ address: '100.64.0.10', family: 'IPv4' as const, internal: false }],
        overlayB: [{ address: '100.64.0.10', family: 'IPv4' as const, internal: false }],
      },
    ]) {
      expect(parseTailscaleStatusSnapshot({ ...nodeIdentity, BackendState: 'Running', TUN: true }, interfaces))
        .toMatchObject({ interfaceName: null, sourceRanges: [] });
    }
  });

  it('reports running for a live backend', () => {
    const snapshot = parseTailscaleStatusSnapshot({ ...nodeIdentity, BackendState: 'Running' });

    expect(snapshot.running).toBe(true);
    expect(snapshot.loggedIn).toBe(true);
  });

  it('reports not running for a stopped backend that is still signed in', () => {
    // The case `loggedIn` alone cannot express: the machine has node identity,
    // so it is signed in, but tailscaled is down and no traffic can flow.
    const snapshot = parseTailscaleStatusSnapshot({ ...nodeIdentity, BackendState: 'Stopped' });

    expect(snapshot.loggedIn).toBe(true);
    expect(snapshot.running).toBe(false);
  });

  it('reports not running while machine authorization is pending', () => {
    const snapshot = parseTailscaleStatusSnapshot({ ...nodeIdentity, BackendState: 'NeedsMachineAuth' });

    expect(snapshot.loggedIn).toBe(true);
    expect(snapshot.running).toBe(false);
  });

  it('reports not running while starting', () => {
    const snapshot = parseTailscaleStatusSnapshot({ ...nodeIdentity, BackendState: 'Starting' });

    expect(snapshot.running).toBe(false);
  });

  it('reports neither running nor logged in when login is required', () => {
    const snapshot = parseTailscaleStatusSnapshot({
      BackendState: 'NeedsLogin',
      AuthURL: 'https://login.tailscale.com/a/example',
    });

    expect(snapshot.loggedIn).toBe(false);
    expect(snapshot.running).toBe(false);
  });

  it('reports not running when the backend state is absent', () => {
    const snapshot = parseTailscaleStatusSnapshot({ ...nodeIdentity });

    expect(snapshot.backendState).toBeNull();
    expect(snapshot.running).toBe(false);
  });
});

describe('tailscaleStatusSnapshotForUnreachableDaemon', () => {
  it('reports a daemon that never answered as neither reachable, running, nor logged in', () => {
    const snapshot = tailscaleStatusSnapshotForUnreachableDaemon();

    expect(snapshot).toMatchObject({ magicDnsEnabled: null, interfaceName: null, sourceRanges: [] });
    expect(snapshot.daemonReachable).toBe(false);
    expect(snapshot.running).toBe(false);
    expect(snapshot.loggedIn).toBe(false);
    expect(snapshot.backendState).toBeNull();
    expect(snapshot.tailscaleIps).toEqual([]);
  });

  it('marks every parsed snapshot as daemon-reachable, because parseable status came from the backend', () => {
    expect(parseTailscaleStatusSnapshot({ ...nodeIdentity, BackendState: 'Running' }).daemonReachable).toBe(true);
    expect(parseTailscaleStatusSnapshot({ ...nodeIdentity, BackendState: 'Stopped' }).daemonReachable).toBe(true);
    expect(parseTailscaleStatusSnapshot({ BackendState: 'NeedsLogin' }).daemonReachable).toBe(true);
  });
});

describe('isTailscaleDaemonUnreachableOutput', () => {
  it.each([
    "failed to connect to local tailscaled; it doesn't appear to be running (sock=/var/run/tailscale/tailscaled.sock)",
    'failed to connect to local backend at http://local-tailscaled.sock',
    'is tailscaled running?',
    'Unable to connect to the Tailscale service. Is the Tailscale service running?',
  ])('recognizes daemon-down output: %s', (text) => {
    expect(isTailscaleDaemonUnreachableOutput(text)).toBe(true);
  });

  it.each([
    'tailscale: command not found',
    'spawn tailscale ENOENT',
    '',
    'Logged out.',
  ])('does not claim daemon-down for unrelated output: %s', (text) => {
    expect(isTailscaleDaemonUnreachableOutput(text)).toBe(false);
  });
});
