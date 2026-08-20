import { describe, expect, it } from 'vitest';

import { parseTailscaleStatusSnapshot } from './statusSnapshot.js';

const nodeIdentity = {
  Self: { DNSName: 'my-machine.tailnet.ts.net.' },
  CurrentTailnet: { Name: 'tailnet.ts.net' },
  TailscaleIPs: ['100.64.0.10'],
  HaveNodeKey: true,
};

describe('parseTailscaleStatusSnapshot', () => {
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
