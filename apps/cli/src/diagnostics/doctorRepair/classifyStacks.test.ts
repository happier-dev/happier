import { describe, expect, it } from 'vitest';

import { classifyStacks } from './classifyStacks';
import type {
  AutomaticStartupEntry,
  LocalRelayEntry,
  RunningDaemonEntry,
} from './types';

function makeService(overrides: Partial<AutomaticStartupEntry> = {}): AutomaticStartupEntry {
  return {
    serverId: 'default',
    name: 'Default automatic startup',
    releaseChannel: 'dev',
    ringId: 'publicdev',
    mode: 'user',
    targetMode: 'default-following',
    relayUrl: 'https://api.happier.dev',
    running: false,
    configuredCliVersion: '0.12.3',
    runningCliVersion: null,
    path: '/Users/me/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
    happierHomeDir: '/Users/me/.happier',
    isForeignHome: false,
    installedDefinitionMatchesExpected: true,
    isLegacyChannelScoped: false,
    ...overrides,
  };
}

function makeDaemon(overrides: Partial<RunningDaemonEntry> = {}): RunningDaemonEntry {
  return {
    serverId: 'default',
    pid: 1234,
    httpPort: 41800,
    startedBy: 'automatic-startup',
    startedWithReleaseChannel: 'dev',
    startedWithCliVersion: '0.12.3',
    matchesCurrentCli: true,
    staleStateFile: false,
    ...overrides,
  };
}

function makeRelay(overrides: Partial<LocalRelayEntry> = {}): LocalRelayEntry {
  return {
    releaseChannel: 'dev',
    ringId: 'publicdev',
    mode: 'user',
    version: '0.12.3',
    serviceActive: true,
    serviceEnabled: true,
    healthy: true,
    relayUrl: 'http://localhost:41872',
    port: 41872,
    installRoot: '/Users/me/.happier/relay-host-dev',
    ...overrides,
  };
}

describe('classifyStacks — channel switch', () => {
  it('fires channel_switch_recommended when active stack is on a different channel than current CLI', () => {
    const previewDaemon = makeDaemon({ startedWithReleaseChannel: 'preview' });
    const { findings } = classifyStacks({
      automaticStartup: [],
      currentlyRunning: [previewDaemon],
      localRelays: [],
      currentCliReleaseChannel: 'dev',
      activeServerUrl: 'https://preview.happier.dev',
    });
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('channel_switch_recommended');
    const f = findings.find((x) => x.kind === 'channel_switch_recommended');
    expect(f?.autoApplyWithoutPrompt).toBe(false);
  });

  it('does NOT fire channel_switch_recommended when a stack on the current CLI channel exists', () => {
    // User has BOTH preview daemon running AND dev service configured. Current
    // CLI is dev → dev stack exists → no channel switch needed (multi-stack OK).
    const previewDaemon = makeDaemon({ startedWithReleaseChannel: 'preview' });
    const devService = makeService({ releaseChannel: 'dev' });
    const { findings } = classifyStacks({
      automaticStartup: [devService],
      currentlyRunning: [previewDaemon],
      localRelays: [],
      currentCliReleaseChannel: 'dev',
      activeServerUrl: 'https://api.happier.dev',
    });
    const kinds = findings.map((f) => f.kind);
    expect(kinds).not.toContain('channel_switch_recommended');
  });

  it('onMigration broadens channel_switch_recommended to auto-apply', () => {
    const previewDaemon = makeDaemon({ startedWithReleaseChannel: 'preview' });
    const { findings } = classifyStacks({
      automaticStartup: [],
      currentlyRunning: [previewDaemon],
      localRelays: [],
      currentCliReleaseChannel: 'dev',
      activeServerUrl: null,
      onMigration: true,
    });
    const f = findings.find((x) => x.kind === 'channel_switch_recommended');
    expect(f?.autoApplyWithoutPrompt).toBe(true);
  });
});

describe('classifyStacks — no active stack yet', () => {
  it('fires no_active_stack_yet when nothing is configured or running', () => {
    const { findings } = classifyStacks({
      automaticStartup: [],
      currentlyRunning: [],
      localRelays: [],
      currentCliReleaseChannel: 'dev',
      activeServerUrl: null,
    });
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('no_active_stack_yet');
  });
});

describe('classifyStacks — dev on hosted cloud', () => {
  it('fires dev_on_hosted_cloud_informational for dev CLI pointing at api.happier.dev without a local dev relay', () => {
    const devService = makeService({ releaseChannel: 'dev' });
    const { findings } = classifyStacks({
      automaticStartup: [devService],
      currentlyRunning: [],
      localRelays: [],
      currentCliReleaseChannel: 'dev',
      activeServerUrl: 'https://api.happier.dev',
    });
    expect(findings.map((f) => f.kind)).toContain('dev_on_hosted_cloud_informational');
  });

  it('does NOT fire dev_on_hosted_cloud_informational when a local dev relay is installed', () => {
    const devService = makeService({ releaseChannel: 'dev' });
    const devRelay = makeRelay({ releaseChannel: 'dev' });
    const { findings } = classifyStacks({
      automaticStartup: [devService],
      currentlyRunning: [],
      localRelays: [devRelay],
      currentCliReleaseChannel: 'dev',
      activeServerUrl: 'https://api.happier.dev',
    });
    expect(findings.map((f) => f.kind)).not.toContain('dev_on_hosted_cloud_informational');
  });

  it('does NOT fire dev_on_hosted_cloud_informational on preview or stable channels', () => {
    const service = makeService({ releaseChannel: 'preview', ringId: 'preview' });
    const { findings } = classifyStacks({
      automaticStartup: [service],
      currentlyRunning: [],
      localRelays: [],
      currentCliReleaseChannel: 'preview',
      activeServerUrl: 'https://api.happier.dev',
    });
    expect(findings.map((f) => f.kind)).not.toContain('dev_on_hosted_cloud_informational');
  });
});

describe('classifyStacks — multi-stack', () => {
  it('fires multi_stack_detected_informational when two daemons run on different channels', () => {
    const devDaemon = makeDaemon({ serverId: 'dev-profile', startedWithReleaseChannel: 'dev' });
    const previewDaemon = makeDaemon({ serverId: 'preview-profile', startedWithReleaseChannel: 'preview' });
    const { findings } = classifyStacks({
      automaticStartup: [],
      currentlyRunning: [devDaemon, previewDaemon],
      localRelays: [],
      currentCliReleaseChannel: 'dev',
      activeServerUrl: null,
    });
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('multi_stack_detected_informational');
    expect(kinds).not.toContain('channel_switch_recommended');
  });
});

describe('classifyStacks — foreign-home isolation', () => {
  it('ignores foreign-home services when building stacks', () => {
    const foreign = makeService({ isForeignHome: true, happierHomeDir: '/opt/old' });
    const { findings, stacks } = classifyStacks({
      automaticStartup: [foreign],
      currentlyRunning: [],
      localRelays: [],
      currentCliReleaseChannel: 'dev',
      activeServerUrl: null,
    });
    // Foreign service doesn't create our stack → no_active_stack_yet fires.
    expect(findings.map((f) => f.kind)).toContain('no_active_stack_yet');
    expect(stacks).toEqual([]);
  });
});
