import type { TailscaleStatusSnapshot } from '@happier-dev/cli-common/tailscale';
import { describe, expect, it } from 'vitest';

import {
  decideTailscaleServeOffer,
  offerAndPublishRelayOnTailnet,
  shouldProbeTailscaleForServeOffer,
} from './hostTailscaleServe';

function snapshot(overrides: Partial<TailscaleStatusSnapshot>): TailscaleStatusSnapshot {
  return {
    backendState: null,
    authUrl: null,
    dnsName: null,
    tailnetName: null,
    tailscaleIps: [],
    loggedIn: false,
    running: false,
    daemonReachable: true,
    ...overrides,
  };
}

const running = snapshot({
  backendState: 'Running',
  running: true,
  loggedIn: true,
  tailnetName: 'example.ts.net',
  dnsName: 'studio.example.ts.net',
  tailscaleIps: ['100.64.0.1'],
});

const base = {
  interactive: true,
  tailscale: running,
  relayUrl: 'http://127.0.0.1:3005',
  serveSlot: { kind: 'free' } as const,
};

describe('decideTailscaleServeOffer', () => {
  it('offers to publish a loopback relay when Tailscale is already running', () => {
    // Everything needed is present: Tailscale installed, signed in, running.
    // Without this the user finishes setup with a relay their phone cannot reach.
    expect(decideTailscaleServeOffer(base)).toEqual({
      kind: 'offer',
      upstreamUrl: 'http://127.0.0.1:3005',
    });
  });

  it('carries the relay port through to the upstream', () => {
    const decision = decideTailscaleServeOffer({ ...base, relayUrl: 'http://127.0.0.1:8899' });

    expect(decision).toMatchObject({ upstreamUrl: 'http://127.0.0.1:8899' });
  });

  it('never asks when it cannot ask', () => {
    expect(decideTailscaleServeOffer({ ...base, interactive: false }))
      .toEqual({ kind: 'skip', reason: 'not-interactive' });
  });

  it('does not offer when Tailscale is signed in but stopped', () => {
    // `tailscale down` keeps the node identity, so `loggedIn` stays true while
    // nothing is listening. Publishing to a stopped backend would silently fail.
    const decision = decideTailscaleServeOffer({
      ...base,
      tailscale: snapshot({ backendState: 'Stopped', loggedIn: true, running: false }),
    });

    expect(decision).toEqual({ kind: 'skip', reason: 'tailscale-not-running' });
  });

  it('does not offer when Tailscale is absent', () => {
    // Installing Tailscale is a separate, larger ask that setup already owns.
    expect(decideTailscaleServeOffer({ ...base, tailscale: null }))
      .toEqual({ kind: 'skip', reason: 'tailscale-not-running' });
  });

  it('does not re-offer when Serve already publishes this relay', () => {
    // Otherwise every `relay host install` on a configured machine asks again.
    expect(decideTailscaleServeOffer({ ...base, serveSlot: { kind: 'exact', httpsUrl: 'https://studio.example.ts.net' } }))
      .toEqual({ kind: 'skip', reason: 'already-published' });
  });

  it('does not offer when the root HTTPS slot already belongs to another Serve or Funnel mapping', () => {
    expect(decideTailscaleServeOffer({
      ...base,
      serveSlot: { kind: 'conflict', exposure: 'funnel', httpsUrl: 'https://studio.example.ts.net' },
    })).toEqual({
      kind: 'skip',
      reason: 'slot-conflict',
      exposure: 'funnel',
      httpsUrl: 'https://studio.example.ts.net',
    });
  });

  it('does not offer for a relay that is already reachable on its own address', () => {
    // `--lan` / `--host <ip>` installs asked for a specific address and got it.
    const decision = decideTailscaleServeOffer({ ...base, relayUrl: 'http://192.168.1.9:3005' });

    expect(decision).toEqual({ kind: 'skip', reason: 'not-loopback' });
  });
});

describe('offerAndPublishRelayOnTailnet', () => {
  const offer = { kind: 'offer', upstreamUrl: 'http://127.0.0.1:3005' } as const;
  const neverAsked = async (): Promise<boolean> => {
    throw new Error('should not have asked');
  };
  const neverEnabled = async (): Promise<{ approvalUrl: string | null }> => {
    throw new Error('should not have enabled');
  };

  it('does not ask at all when the decision was to skip', async () => {
    const outcome = await offerAndPublishRelayOnTailnet({
      decision: { kind: 'skip', reason: 'tailscale-not-running' },
      confirm: neverAsked,
      enableServe: neverEnabled,
    });

    expect(outcome).toEqual({ kind: 'skipped' });
  });

  it('publishes the relay when the user accepts', async () => {
    const enabled: string[] = [];

    const outcome = await offerAndPublishRelayOnTailnet({
      decision: offer,
      confirm: async () => true,
      enableServe: async (upstreamUrl) => {
        enabled.push(upstreamUrl);
        return { approvalUrl: null };
      },
    });

    expect(outcome).toEqual({ kind: 'published' });
    expect(enabled).toEqual(['http://127.0.0.1:3005']);
  });

  it('does not touch Tailscale when the user declines', async () => {
    const outcome = await offerAndPublishRelayOnTailnet({
      decision: offer,
      confirm: async () => false,
      enableServe: neverEnabled,
    });

    expect(outcome).toEqual({ kind: 'declined' });
  });

  it('reports a tailnet that withholds the address pending admin approval', async () => {
    // `tailscale serve` exits fine here, but no address answers yet. Calling
    // this published would adopt a URL nothing is listening on.
    const outcome = await offerAndPublishRelayOnTailnet({
      decision: offer,
      confirm: async () => true,
      enableServe: async () => ({ approvalUrl: 'https://login.tailscale.com/f/serve?node=abc' }),
    });

    expect(outcome).toEqual({
      kind: 'approvalNeeded',
      approvalUrl: 'https://login.tailscale.com/f/serve?node=abc',
    });
  });

  it('reports a failure instead of throwing through the install', async () => {
    // The relay is installed by this point; a Serve failure must not unwind it.
    const outcome = await offerAndPublishRelayOnTailnet({
      decision: offer,
      confirm: async () => true,
      enableServe: async () => {
        throw new Error('tailscaled is not running');
      },
    });

    expect(outcome).toEqual({ kind: 'failed', message: 'tailscaled is not running' });
  });
});

describe('shouldProbeTailscaleForServeOffer', () => {
  it('probes only when an offer is still possible', () => {
    expect(shouldProbeTailscaleForServeOffer({
      interactive: true,
      relayUrl: 'http://127.0.0.1:3005',
    })).toBe(true);
  });

  it('does not spawn tailscale for an install that could never offer', () => {
    // Every one of these ends in `skip` regardless of what Tailscale says, so
    // asking it costs a subprocess to learn nothing. A unit test running the
    // install path should not be shelling out either.
    expect(shouldProbeTailscaleForServeOffer({
      interactive: false,
      relayUrl: 'http://127.0.0.1:3005',
    })).toBe(false);
    expect(shouldProbeTailscaleForServeOffer({
      interactive: true,
      relayUrl: 'http://192.168.1.9:3005',
    })).toBe(false);
  });

  it('agrees with the full decision on every input it gates', () => {
    // The cheap gate must never suppress an offer the full decision would make.
    const cases = [
      { interactive: true, relayUrl: 'http://127.0.0.1:3005' },
      { interactive: true, relayUrl: 'http://[::1]:3005' },
      { interactive: false, relayUrl: 'http://127.0.0.1:3005' },
      { interactive: true, relayUrl: 'http://192.168.1.9:3005' },
    ];

    for (const input of cases) {
      const full = decideTailscaleServeOffer({ ...input, tailscale: running, serveSlot: { kind: 'free' } });
      if (full.kind === 'offer') {
        expect(shouldProbeTailscaleForServeOffer(input)).toBe(true);
      }
    }
  });
});
