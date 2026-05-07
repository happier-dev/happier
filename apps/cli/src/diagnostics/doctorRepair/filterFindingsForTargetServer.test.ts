import { describe, expect, it } from 'vitest';

import { filterFindingsForTargetServer } from './filterFindingsForTargetServer';
import type { AutomaticStartupEntry, RepairFinding, RunningDaemonEntry } from './types';

function makeEntry(overrides: Partial<AutomaticStartupEntry> = {}): AutomaticStartupEntry {
  return {
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
    path: '/Users/me/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
    happierHomeDir: '/Users/me/.happier',
    isForeignHome: false,
    installedDefinitionMatchesExpected: true,
    isLegacyChannelScoped: false,
    managedServerIds: ['target-id'],
    ...overrides,
  };
}

function makeDaemon(overrides: Partial<RunningDaemonEntry> = {}): RunningDaemonEntry {
  return {
    serverId: 'target-id',
    pid: 1234,
    httpPort: 41800,
    startedBy: 'manual',
    startedWithReleaseChannel: 'dev',
    startedWithCliVersion: '0.11.9',
    matchesCurrentCli: false,
    staleStateFile: false,
    ...overrides,
  };
}

describe('filterFindingsForTargetServer', () => {
  it('drops orthogonal stack-level findings', () => {
    const findings: RepairFinding[] = [
      { kind: 'channel_switch_recommended', severity: 'warning', autoApplyWithoutPrompt: false } as unknown as RepairFinding,
      { kind: 'multi_stack_detected_informational', severity: 'info', autoApplyWithoutPrompt: false } as unknown as RepairFinding,
      { kind: 'dev_on_hosted_cloud_informational', severity: 'info', autoApplyWithoutPrompt: false } as unknown as RepairFinding,
    ];
    const result = filterFindingsForTargetServer(findings, {
      targetServerId: 'target-id',
      automaticStartup: [],
      currentlyRunning: [],
    });
    expect(result).toEqual([]);
  });

  it('always preserves cli_self_update_available, no_servers_configured, server_profile_missing, foreign_home', () => {
    const findings: RepairFinding[] = [
      { kind: 'cli_self_update_available', severity: 'info', autoApplyWithoutPrompt: false, releaseChannel: 'dev', currentVersion: '0.12.0', latestVersion: '0.12.3' },
      { kind: 'no_servers_configured', severity: 'warning', autoApplyWithoutPrompt: false },
      { kind: 'server_profile_missing', severity: 'warning', autoApplyWithoutPrompt: false, serverId: 'target-id' },
      { kind: 'automatic_startup_foreign_home', severity: 'warning', autoApplyWithoutPrompt: false, entries: [], messages: [] },
    ];
    const result = filterFindingsForTargetServer(findings, {
      targetServerId: 'target-id',
      automaticStartup: [],
      currentlyRunning: [],
    });
    expect(result.map((f) => f.kind)).toEqual([
      'cli_self_update_available',
      'no_servers_configured',
      'server_profile_missing',
      'automatic_startup_foreign_home',
    ]);
  });

  it('keeps auth findings only for the target server', () => {
    const findings: RepairFinding[] = [
      { kind: 'auth_missing_for_profile', severity: 'warning', autoApplyWithoutPrompt: false, serverId: 'other', serverName: 'Other', serverUrl: 'https://other.test' },
      { kind: 'auth_missing_for_profile', severity: 'warning', autoApplyWithoutPrompt: false, serverId: 'target-id', serverName: 'Target', serverUrl: 'https://target.test' },
      { kind: 'machine_not_registered_for_profile', severity: 'warning', autoApplyWithoutPrompt: false, serverId: 'target-id', serverName: 'Target', serverUrl: 'https://target.test' },
    ];
    const result = filterFindingsForTargetServer(findings, {
      targetServerId: 'target-id',
      automaticStartup: [],
      currentlyRunning: [],
    });
    expect(result).toHaveLength(2);
    expect(result.every((f) => 'serverId' in f && (f as { serverId: string }).serverId === 'target-id')).toBe(true);
  });

  it('keeps automatic-startup entry findings only when entry manages target server', () => {
    const targetEntry = makeEntry({ managedServerIds: ['target-id'] });
    const otherEntry = makeEntry({ serverId: 'other', managedServerIds: ['other'] });

    const findings: RepairFinding[] = [
      { kind: 'automatic_startup_version_stale', severity: 'info', autoApplyWithoutPrompt: true, entry: targetEntry, currentCliVersion: '0.12.3' },
      { kind: 'automatic_startup_version_stale', severity: 'info', autoApplyWithoutPrompt: true, entry: otherEntry, currentCliVersion: '0.12.3' },
      { kind: 'automatic_startup_stale_definition', severity: 'warning', autoApplyWithoutPrompt: true, entry: targetEntry },
    ];
    const result = filterFindingsForTargetServer(findings, {
      targetServerId: 'target-id',
      automaticStartup: [targetEntry, otherEntry],
      currentlyRunning: [],
    });
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.kind !== 'automatic_startup_version_stale' || ('entry' in f && f.entry === targetEntry))).toBe(true);
  });

  it('keeps duplicate findings when ANY referenced entry touches the target', () => {
    const targetEntry = makeEntry({ managedServerIds: ['target-id'], path: '/keeper.plist' });
    const dupEntry = makeEntry({ managedServerIds: ['other'], path: '/dup.plist' });

    const findings: RepairFinding[] = [
      { kind: 'automatic_startup_duplicate_default_following', severity: 'warning', autoApplyWithoutPrompt: true, keeper: targetEntry, duplicates: [dupEntry] },
    ];
    const result = filterFindingsForTargetServer(findings, {
      targetServerId: 'target-id',
      automaticStartup: [targetEntry, dupEntry],
      currentlyRunning: [],
    });
    expect(result).toHaveLength(1);
  });

  it('keeps running-daemon findings only for daemons on the target profile', () => {
    const targetDaemon = makeDaemon({ serverId: 'target-id' });
    const otherDaemon = makeDaemon({ serverId: 'other', pid: 5678 });

    const findings: RepairFinding[] = [
      { kind: 'running_daemon_cli_mismatch', severity: 'warning', autoApplyWithoutPrompt: false, daemon: targetDaemon, currentCliReleaseChannel: 'dev', currentCliVersion: '0.12.3', driftKind: 'version-only', recoveryStrategy: 'daemon-takeover', serviceManagerName: null },
      { kind: 'running_daemon_cli_mismatch', severity: 'warning', autoApplyWithoutPrompt: false, daemon: otherDaemon, currentCliReleaseChannel: 'dev', currentCliVersion: '0.12.3', driftKind: 'version-only', recoveryStrategy: 'daemon-takeover', serviceManagerName: null },
    ];
    const result = filterFindingsForTargetServer(findings, {
      targetServerId: 'target-id',
      automaticStartup: [],
      currentlyRunning: [targetDaemon, otherDaemon],
    });
    expect(result).toHaveLength(1);
    expect((result[0] as { daemon: RunningDaemonEntry }).daemon.serverId).toBe('target-id');
  });

  it('drops local-relay findings (orthogonal to single-server scope)', () => {
    const findings: RepairFinding[] = [
      { kind: 'local_relay_lane_missing', severity: 'info', autoApplyWithoutPrompt: false, targetReleaseChannel: 'dev', installed: [] },
    ];
    const result = filterFindingsForTargetServer(findings, {
      targetServerId: 'target-id',
      automaticStartup: [],
      currentlyRunning: [],
    });
    expect(result).toEqual([]);
  });

  it('preserves automatic_startup_missing in scoped mode (asks "is there a service for the target?")', () => {
    const findings: RepairFinding[] = [
      { kind: 'automatic_startup_missing', severity: 'info', autoApplyWithoutPrompt: false, targetReleaseChannel: 'dev', preferredMode: 'user' },
    ];
    const result = filterFindingsForTargetServer(findings, {
      targetServerId: 'target-id',
      automaticStartup: [],
      currentlyRunning: [],
    });
    expect(result).toHaveLength(1);
  });
});
