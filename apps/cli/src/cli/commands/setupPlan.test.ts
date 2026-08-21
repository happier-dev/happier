import type { TailscaleStatusSnapshot } from '@happier-dev/cli-common/tailscale';
import { describe, expect, it } from 'vitest';

import { buildSetupPlan, parseSetupArgs, type SetupAutonomy } from './setupPlan';

const base = {
  autonomy: 'interactive' as SetupAutonomy,
  auth: { authenticated: false, machineRegistered: false },
  activeRelayUrl: null,
  relaySelection: null,
  installedAgentIds: ['claude'] as readonly string[],
  tailscale: null,
};

function tailscaleSnapshot(overrides: Partial<TailscaleStatusSnapshot>): TailscaleStatusSnapshot {
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

describe('buildSetupPlan', () => {
  it('creates nothing when it cannot ask and nothing is configured', () => {
    // The installer's own precedent: a no-TTY run never creates state the user
    // did not ask for. Setup must refuse rather than pick a relay for them.
    const plan = buildSetupPlan({ ...base, autonomy: 'createNothing' });

    expect(plan.steps).toEqual([]);
    expect(plan.stop?.reason).toBe('needs-interactive');
  });

  it('is a no-op for a machine that is already set up', () => {
    const plan = buildSetupPlan({
      ...base,
      auth: { authenticated: true, machineRegistered: true },
      activeRelayUrl: 'https://api.happier.dev',
      autonomy: 'createNothing',
    });

    expect(plan.stop).toBeNull();
    expect(plan.steps.map((step) => step.kind)).toEqual(['alreadyConfigured']);
  });

  it('goes straight to sign-in for Happier Cloud', () => {
    const plan = buildSetupPlan({ ...base, relaySelection: { kind: 'cloud' } });

    expect(plan.steps.map((step) => step.kind)).toEqual(['authLogin']);
  });

  it('selects a relay before signing in, because credentials are per relay', () => {
    const plan = buildSetupPlan({
      ...base,
      relaySelection: { kind: 'existing', url: 'https://relay.example.com' },
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['selectRelay', 'authLogin']);
    expect(plan.steps[0]).toMatchObject({ relayUrl: 'https://relay.example.com' });
  });

  it('warns about a missing coding agent without blocking setup', () => {
    // Happier drives an agent; it ships none. Today this is only discovered at
    // the finish line, after pairing, as a raw resolver error.
    const plan = buildSetupPlan({
      ...base,
      relaySelection: { kind: 'cloud' },
      installedAgentIds: [],
    });

    expect(plan.stop).toBeNull();
    expect(plan.steps.map((step) => step.kind)).toEqual(['authLogin', 'warnNoAgent']);
  });

  it('does not warn when at least one agent is installed', () => {
    const plan = buildSetupPlan({
      ...base,
      relaySelection: { kind: 'cloud' },
      installedAgentIds: ['codex'],
    });

    expect(plan.steps.map((step) => step.kind)).not.toContain('warnNoAgent');
  });

  it('re-signs in when a relay is chosen that differs from the active one', () => {
    const plan = buildSetupPlan({
      ...base,
      auth: { authenticated: true, machineRegistered: true },
      activeRelayUrl: 'https://api.happier.dev',
      relaySelection: { kind: 'existing', url: 'https://relay.example.com' },
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['selectRelay', 'authLogin']);
  });

  it('names the tailnet a relay on this computer will be reachable over', () => {
    const plan = buildSetupPlan({
      ...base,
      relaySelection: { kind: 'thisComputer' },
      tailscale: tailscaleSnapshot({
        backendState: 'Running',
        running: true,
        loggedIn: true,
        tailnetName: 'example.ts.net',
        dnsName: 'studio.example.ts.net',
        tailscaleIps: ['100.64.0.1'],
      }),
    });

    expect(plan.steps.map((step) => step.kind)).toEqual([
      'explainRelayReachability',
      'installLocalRelay',
      'reportRelayReachability',
      'authLogin',
    ]);
    const reachability = { kind: 'tailnet', tailnetName: 'example.ts.net' };
    expect(plan.steps[0]).toMatchObject({ reachability });
    expect(plan.steps[2]).toMatchObject({ reachability });
  });

  it('does not call a signed-in but stopped Tailscale reachable', () => {
    // `tailscale down` keeps the node identity, so `loggedIn` stays true and the
    // tailnet IPs keep being reported while nothing is listening on them. Only
    // a running backend can carry the phone's traffic.
    const plan = buildSetupPlan({
      ...base,
      relaySelection: { kind: 'thisComputer' },
      tailscale: tailscaleSnapshot({
        backendState: 'Stopped',
        running: false,
        loggedIn: true,
        tailnetName: 'example.ts.net',
        dnsName: 'studio.example.ts.net',
        tailscaleIps: ['100.64.0.1'],
      }),
    });

    expect(plan.steps[0]).toMatchObject({ reachability: { kind: 'tailscaleNotRunning' } });
    // Tailscale is already installed; offering to install it again would be wrong.
    expect(plan.steps.map((step) => step.kind)).not.toContain('offerTailscaleSetup');
  });

  it('treats an unreachable tailscaled as not running rather than as absent', () => {
    const plan = buildSetupPlan({
      ...base,
      relaySelection: { kind: 'thisComputer' },
      tailscale: tailscaleSnapshot({ daemonReachable: false }),
    });

    expect(plan.steps[0]).toMatchObject({ reachability: { kind: 'tailscaleNotRunning' } });
    expect(plan.steps.map((step) => step.kind)).not.toContain('offerTailscaleSetup');
  });

  it('offers Tailscale setup after the install when Tailscale is absent', () => {
    const plan = buildSetupPlan({
      ...base,
      relaySelection: { kind: 'thisComputer' },
      tailscale: null,
    });

    expect(plan.steps.map((step) => step.kind)).toEqual([
      'explainRelayReachability',
      'installLocalRelay',
      'reportRelayReachability',
      'offerTailscaleSetup',
      'authLogin',
    ]);
    expect(plan.steps[0]).toMatchObject({ reachability: { kind: 'tailscaleNotInstalled' } });
  });

  it('says nothing about reachability for a relay it does not host', () => {
    const plan = buildSetupPlan({
      ...base,
      relaySelection: { kind: 'existing', url: 'https://relay.example.com' },
      tailscale: null,
    });

    expect(plan.steps.map((step) => step.kind)).not.toContain('explainRelayReachability');
    expect(plan.steps.map((step) => step.kind)).not.toContain('reportRelayReachability');
    expect(plan.steps.map((step) => step.kind)).not.toContain('offerTailscaleSetup');
  });
});

describe('buildSetupPlan — choosing Happier Cloud', () => {
  it('switches an existing custom relay back to Cloud', () => {
    // The failure this guards: a half-finished earlier setup left a custom relay
    // active. Choosing Cloud emitted no selection step, so `auth login` bound the
    // account to the custom relay the user had just declined.
    const plan = buildSetupPlan({
      ...base,
      activeRelayUrl: 'https://relay.example.com',
      relaySelection: { kind: 'cloud' },
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['selectCloudRelay', 'authLogin']);
  });

  it('does not switch relays when none is configured yet', () => {
    // A fresh machine already defaults to Cloud; selecting it is a no-op.
    const plan = buildSetupPlan({ ...base, relaySelection: { kind: 'cloud' } });

    expect(plan.steps.map((step) => step.kind)).toEqual(['authLogin']);
  });
});

describe('buildSetupPlan — readiness is more than credential bytes', () => {
  it('does not call a machine whose credentials the relay rejected already set up', () => {
    // The installer hands off to setup precisely when something is wrong. Setup
    // seeing credential bytes and answering "already configured" is how a
    // rejected token survives a re-install.
    const plan = buildSetupPlan({
      ...base,
      auth: { authenticated: false, machineRegistered: true },
      activeRelayUrl: 'https://api.happier.dev',
    });

    expect(plan.steps.map((step) => step.kind)).toEqual([]);
    expect(plan.stop).toBeNull();
  });

  it('does not call a machine without a registered machine identity already set up', () => {
    const plan = buildSetupPlan({
      ...base,
      auth: { authenticated: true, machineRegistered: false },
      activeRelayUrl: 'https://api.happier.dev',
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['authLogin']);
    expect(plan.stop).toBeNull();
  });

  it('is a no-op only when the relay accepted the credentials and the machine is registered', () => {
    const plan = buildSetupPlan({
      ...base,
      auth: { authenticated: true, machineRegistered: true },
      activeRelayUrl: 'https://api.happier.dev',
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['alreadyConfigured']);
  });
});

describe('buildSetupPlan — no terminal at all', () => {
  it('creates nothing even when the relay was chosen on the command line', () => {
    // `--non-interactive` (and HAPPIER_NONINTERACTIVE=1, and a missing terminal)
    // means "nobody is here": setup reports what it would need and writes
    // nothing. `--yes` is the flag that asks for the work to be done.
    const plan = buildSetupPlan({
      ...base,
      autonomy: 'createNothing',
      relaySelection: { kind: 'cloud' },
    });

    expect(plan.steps).toEqual([]);
    expect(plan.stop?.reason).toBe('needs-interactive');
    expect(plan.stop?.detail).toContain('--yes');
  });

  it('creates nothing for a relay hosted on this computer', () => {
    const plan = buildSetupPlan({
      ...base,
      autonomy: 'createNothing',
      relaySelection: { kind: 'thisComputer' },
      tailscale: null,
    });

    expect(plan.steps).toEqual([]);
    expect(plan.stop?.reason).toBe('needs-interactive');
  });
});

describe('buildSetupPlan — unattended runs (--yes)', () => {
  it('points the machine at Happier Cloud and stops at the step a person has to approve', () => {
    const plan = buildSetupPlan({
      ...base,
      autonomy: 'unattended',
      activeRelayUrl: 'https://relay.example.com',
      relaySelection: { kind: 'cloud' },
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['selectCloudRelay']);
    expect(plan.stop?.reason).toBe('needs-sign-in');
    expect(plan.stop?.detail).toContain('happier auth login');
  });

  it('never plans a sign-in that has to be approved on a device', () => {
    const plan = buildSetupPlan({
      ...base,
      autonomy: 'unattended',
      relaySelection: { kind: 'existing', url: 'https://relay.example.com' },
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['selectRelay']);
    expect(plan.steps.map((step) => step.kind)).not.toContain('authLogin');
    expect(plan.stop?.reason).toBe('needs-sign-in');
  });

  it('installs a relay on this computer but never offers to install Tailscale', () => {
    // Every other step here needs no answer. Offering to install a VPN is a
    // question, and a question nobody is watching cannot be asked.
    const plan = buildSetupPlan({
      ...base,
      autonomy: 'unattended',
      relaySelection: { kind: 'thisComputer' },
      tailscale: null,
    });

    expect(plan.steps.map((step) => step.kind)).toEqual([
      'explainRelayReachability',
      'installLocalRelay',
      'reportRelayReachability',
    ]);
    expect(plan.stop?.reason).toBe('needs-sign-in');
  });

  it('still says nothing was chosen when no relay was named', () => {
    // `--yes` means "accept the recommended defaults", and there is no
    // recommended answer to "where does your relay live?". Picking one would
    // create an account somewhere the user never asked for.
    const plan = buildSetupPlan({ ...base, autonomy: 'unattended' });

    expect(plan.steps).toEqual([]);
    expect(plan.stop?.reason).toBe('needs-relay-choice');
    expect(plan.stop?.detail).toContain('--cloud');
  });

  it('still warns about a missing coding agent', () => {
    const plan = buildSetupPlan({
      ...base,
      autonomy: 'unattended',
      relaySelection: { kind: 'cloud' },
      installedAgentIds: [],
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['warnNoAgent']);
  });

  it('leaves an already configured machine alone', () => {
    const plan = buildSetupPlan({
      ...base,
      autonomy: 'unattended',
      auth: { authenticated: true, machineRegistered: true },
      activeRelayUrl: 'https://api.happier.dev',
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['alreadyConfigured']);
    expect(plan.stop).toBeNull();
  });
});

describe('parseSetupArgs', () => {
  it('reads a relay chosen on the command line', () => {
    expect(parseSetupArgs(['--relay', 'https://relay.example.com'])).toEqual({
      kind: 'run',
      relaySelection: { kind: 'existing', url: 'https://relay.example.com' },
      assumeYes: false,
      forcedNonInteractive: false,
    });
  });

  it('rejects two different answers to the same question', () => {
    const parsed = parseSetupArgs(['--cloud', '--relay', 'https://relay.example.com']);

    expect(parsed.kind).toBe('invalid');
  });

  it('rejects --this-computer combined with --cloud', () => {
    expect(parseSetupArgs(['--this-computer', '--cloud']).kind).toBe('invalid');
  });

  it('rejects --relay without a URL', () => {
    expect(parseSetupArgs(['--relay']).kind).toBe('invalid');
    expect(parseSetupArgs(['--relay', '--cloud']).kind).toBe('invalid');
  });

  it('rejects an option it does not know', () => {
    // Silently ignoring a typo is how `--this-computer` misspelled once became a
    // Cloud account nobody asked for.
    expect(parseSetupArgs(['--this-comptuer']).kind).toBe('invalid');
  });

  it('recognises help', () => {
    expect(parseSetupArgs(['--help']).kind).toBe('help');
    expect(parseSetupArgs(['-h']).kind).toBe('help');
  });

  it('keeps --yes and --non-interactive apart, because they now ask for opposite things', () => {
    // `--yes` says "do everything that needs no answer"; `--non-interactive`
    // says "change nothing". Collapsing them into one boolean is what made
    // `--yes` refuse to do the work it was asked to do.
    expect(parseSetupArgs(['--yes', '--cloud'])).toEqual({
      kind: 'run',
      relaySelection: { kind: 'cloud' },
      assumeYes: true,
      forcedNonInteractive: false,
    });
    expect(parseSetupArgs(['--non-interactive'])).toEqual({
      kind: 'run',
      relaySelection: null,
      assumeYes: false,
      forcedNonInteractive: true,
    });
  });

  it('refuses --yes together with --non-interactive', () => {
    const parsed = parseSetupArgs(['--cloud', '--yes', '--non-interactive']);

    expect(parsed.kind).toBe('invalid');
  });
});
