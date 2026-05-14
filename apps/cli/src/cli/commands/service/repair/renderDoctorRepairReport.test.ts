import { describe, expect, it } from 'vitest';

import type {
  AutomaticStartupEntry,
  CurrentCliInfo,
  DoctorRepairReport,
  LocalRelayEntry,
  RepairFinding,
  RunningDaemonEntry,
} from '@/diagnostics/doctorRepair';

import { renderDoctorRepairReport } from './renderDoctorRepairReport';

const cli: CurrentCliInfo = {
  releaseChannel: 'dev',
  ringId: 'publicdev',
  version: '0.12.3',
  binaryPath: '/home/me/.happier/cli-dev/current/bin/happier',
  shim: 'hdev',
  invoker: 'hdev',
  pathWinnerShim: 'happier',
  pathWinnerResolvesToThisBinary: true,
};

const entry: AutomaticStartupEntry = {
  serverId: 'default',
  name: 'Default automatic startup',
  releaseChannel: 'dev',
  ringId: 'publicdev',
  mode: 'user',
  targetMode: 'default-following',
  relayUrl: 'https://api.happier.dev',
  running: true,
  configuredCliVersion: '0.12.3',
  runningCliVersion: '0.12.3',
  path: '/home/me/Library/LaunchAgents/com.happier.default.plist',
  happierHomeDir: '/home/me/.happier',
  isForeignHome: false,
  installedDefinitionMatchesExpected: true,
  isLegacyChannelScoped: false,
};

function makeReport(overrides: Partial<DoctorRepairReport> = {}): DoctorRepairReport {
  return {
    currentCli: cli,
    automaticStartup: [entry],
    currentlyRunning: [],
    localRelays: [],
    authProfiles: [],
    hasAnyServerProfile: false,
    findings: [],
    manualWarnings: [],
    ...overrides,
  };
}

describe('renderDoctorRepairReport — clean state', () => {
  it('renders the 3-line "looks good" block when no findings', () => {
    const out = renderDoctorRepairReport(makeReport()).join('\n');
    expect(out).toContain('Your Happier installation looks good');
    expect(out).toContain('Current CLI');
    expect(out).toContain('Background services');
    expect(out).toContain('matches this CLI');
    // 'Currently running' is gone — its content lives inside Background services.
    expect(out).not.toContain('Currently running');
  });

  it('omits the local-relay line when no relay is installed', () => {
    const out = renderDoctorRepairReport(makeReport()).join('\n');
    expect(out).not.toContain('Local relay');
  });

  it('includes the local-relay line when a matching relay is installed', () => {
    const relay: LocalRelayEntry = {
      releaseChannel: 'dev',
      ringId: 'publicdev',
      mode: 'user',
      version: '0.12.3',
      serviceActive: true,
      serviceEnabled: true,
      healthy: true,
      relayUrl: 'http://localhost:41872',
      port: 41872,
      installRoot: '/home/me/.happier/relay-host-dev',
    };
    const out = renderDoctorRepairReport(makeReport({ localRelays: [relay] })).join('\n');
    expect(out).toContain('Local relay');
    expect(out).toContain('http://localhost:41872');
  });

  it('shows configured (not running) when startup is present but stopped', () => {
    const stopped = { ...entry, running: false };
    const out = renderDoctorRepairReport(makeReport({ automaticStartup: [stopped] })).join('\n');
    expect(out).toContain('configured (not currently running)');
  });

  it('does not call a fallback wrong-lane background service a CLI match', () => {
    const stableEntry: AutomaticStartupEntry = {
      ...entry,
      releaseChannel: 'stable',
      ringId: 'stable',
      configuredCliVersion: '0.2.1-preview.4227',
      runningCliVersion: '0.2.1-preview.4227',
    };
    const out = renderDoctorRepairReport(makeReport({
      automaticStartup: [stableEntry],
    })).join('\n');
    expect(out).toContain('different release channel');
    expect(out).not.toContain('matches this CLI');
  });
});

describe('renderDoctorRepairReport — mismatched state', () => {
  it('renders the mismatch header and all relevant sections', () => {
    const stale = { ...entry, running: true, runningCliVersion: '0.12.1' };
    const finding: RepairFinding = {
      kind: 'automatic_startup_version_stale',
      severity: 'info',
      autoApplyWithoutPrompt: true,
      entry: stale,
      currentCliVersion: '0.12.3',
    };
    const out = renderDoctorRepairReport(
      makeReport({ automaticStartup: [stale], findings: [finding] }),
    ).join('\n');
    expect(out).toContain('might need some attention');
    expect(out).toContain('Current CLI');
    expect(out).toContain('Background services');
    expect(out).toContain('restart to pick it up');
  });

  it('lists manually-started daemons inside Background services', () => {
    // Use a distinct serverId so the merge doesn't dedupe this row against
    // the default automatic-startup entry in `makeReport()`.
    const running: RunningDaemonEntry = {
      serverId: 'company',
      pid: 1234,
      httpPort: 41800,
      startedBy: 'manual',
      startedWithReleaseChannel: 'dev',
      startedWithCliVersion: '0.11.9',
      matchesCurrentCli: false,
      staleStateFile: false,
    };
    const finding: RepairFinding = {
      kind: 'running_daemon_cli_mismatch',
      severity: 'warning',
      autoApplyWithoutPrompt: false,
      daemon: running,
      currentCliReleaseChannel: 'dev',
      currentCliVersion: '0.12.3',
      driftKind: 'version-only',
      recoveryStrategy: 'daemon-takeover',
      serviceManagerName: null,
    };
    const out = renderDoctorRepairReport(makeReport({
      currentlyRunning: [running],
      findings: [finding],
    })).join('\n');
    expect(out).toContain('Background services');
    expect(out).toContain('pid 1234');
    expect(out).toContain('started manually');
  });

  it('renders "is on the stable release channel" wording (no "is stable")', () => {
    const relay: LocalRelayEntry = {
      releaseChannel: 'stable',
      ringId: 'stable',
      mode: 'user',
      version: '0.11.4',
      serviceActive: true,
      serviceEnabled: true,
      healthy: true,
      relayUrl: 'http://localhost:41870',
      port: 41870,
      installRoot: '/home/me/.happier/relay-host-stable',
    };
    const finding: RepairFinding = {
      kind: 'local_relay_lane_missing',
      severity: 'info',
      autoApplyWithoutPrompt: false,
      targetReleaseChannel: 'dev',
      installed: [relay],
    };
    const out = renderDoctorRepairReport(makeReport({
      localRelays: [relay],
      findings: [finding],
    })).join('\n');
    expect(out).toContain('Local relays');
    expect(out).toContain('different release channel');
  });
});

describe('renderDoctorRepairReport — card layout', () => {
  it('a card with a finding renders an arrow-prefixed sub-line with the diagnostic text', () => {
    const finding: RepairFinding = {
      kind: 'automatic_startup_stale_definition',
      severity: 'warning',
      autoApplyWithoutPrompt: true,
      entry,
    };
    const mismatched = renderDoctorRepairReport(makeReport({ findings: [finding] })).join('\n');
    // An arrow-prefixed sub-line appears specifically for the drift diagnosis.
    expect(mismatched).toMatch(/→.*service definition drifted/);
  });

  it('card uses ● glyph for entries', () => {
    const finding: RepairFinding = {
      kind: 'automatic_startup_stale_definition',
      severity: 'warning',
      autoApplyWithoutPrompt: true,
      entry,
    };
    const out = renderDoctorRepairReport(makeReport({ findings: [finding] })).join('\n');
    expect(out).toContain('●');
  });
});
