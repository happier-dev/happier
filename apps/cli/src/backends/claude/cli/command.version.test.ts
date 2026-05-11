import { afterEach, describe, expect, it, vi } from 'vitest';

import * as authModule from '@/ui/auth';
import * as runClaudeModule from '@/backends/claude/runClaude';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import * as providerSettingsModule from '@/settings/providerSettings';

const { execFileSyncSpy } = vi.hoisted(() => ({
  execFileSyncSpy: vi.fn(() => '2.1.138 (Claude Code)\n'),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: execFileSyncSpy };
});

import { handleClaudeCliCommand } from './command';

afterEach(() => {
  vi.restoreAllMocks();
  execFileSyncSpy.mockClear();
});

describe('handleClaudeCliCommand --version', () => {
  it('passes explicit Claude version requests through without auth or session startup', async () => {
    const previousClaudePath = process.env.HAPPIER_CLAUDE_PATH;
    process.env.HAPPIER_CLAUDE_PATH = process.execPath;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } as any } as any);
    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({} as any);

    try {
      await handleClaudeCliCommand({
        args: ['claude', '--version'],
        terminalRuntime: null,
        rawArgv: ['happier', 'claude', '--version'],
      } as any);

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        process.execPath,
        ['--version'],
        expect.objectContaining({
          encoding: 'utf8',
          windowsHide: true,
        }),
      );
      expect(logSpy).toHaveBeenCalledWith('2.1.138 (Claude Code)');
      expect(authSpy).not.toHaveBeenCalled();
      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      if (previousClaudePath === undefined) {
        delete process.env.HAPPIER_CLAUDE_PATH;
      } else {
        process.env.HAPPIER_CLAUDE_PATH = previousClaudePath;
      }
    }
  });

  it('fast-starts local terminal invocations without blocking on auth/setup', async () => {
    const credentials = { token: 'x' } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});

    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: [],
      terminalRuntime: null,
      rawArgv: ['happier'],
    } as any);

    expect(readCredentialsSpy).toHaveBeenCalled();
    expect(authSpy).not.toHaveBeenCalled();
    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        credentials,
        mode: 'fast',
        refresh: 'auto',
      }),
    );
    expect(runSpy).toHaveBeenCalledWith(credentials, expect.any(Object));
  });

  it('binds existing credentials through the token-aware machine id helper', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    const ensureMachineSpy = vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: [],
      terminalRuntime: null,
      rawArgv: ['happier'],
    } as any);

    expect(ensureMachineSpy).toHaveBeenCalledWith(credentials);
  });

  it('uses fast account settings bootstrap even when forcing refresh', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--refresh-settings'],
      terminalRuntime: null,
      rawArgv: ['happier', '--refresh-settings'],
    } as any);

    expect(accountSettingsModule.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        credentials,
        mode: 'fast',
        refresh: 'force',
      }),
    );
  });

  it('uses fast account settings bootstrap for daemon-started Claude sessions', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--started-by', 'daemon', '--happy-starting-mode', 'remote'],
      terminalRuntime: null,
      rawArgv: ['happier', '--started-by', 'daemon', '--happy-starting-mode', 'remote'],
    } as any);

    expect(accountSettingsModule.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        credentials,
      mode: 'fast',
      refresh: 'force',
      }),
    );
  });

  it('ignores obsolete child account settings version hints for daemon-started Claude sessions', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'network',
      settings: {} as any,
      settingsVersion: 14,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--started-by', 'daemon', '--happy-starting-mode', 'remote', '--account-settings-version-hint', '14'],
      terminalRuntime: null,
      rawArgv: ['happier', '--started-by', 'daemon', '--happy-starting-mode', 'remote', '--account-settings-version-hint', '14'],
    } as any);

    expect(accountSettingsModule.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        credentials,
        mode: 'fast',
        refresh: 'force',
      }),
    );
    expect(accountSettingsModule.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
      expect.not.objectContaining({
        minSettingsVersion: expect.any(Number),
      }),
    );
    expect(runSpy).toHaveBeenCalledWith(credentials, expect.any(Object));
    expect(runSpy.mock.calls[0]?.[1]).not.toHaveProperty('claudeArgs');
  });

  it('forces a fresh blocking account settings bootstrap for terminal remote Claude starts', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--happy-starting-mode', 'remote'],
      terminalRuntime: null,
      rawArgv: ['happier', '--happy-starting-mode', 'remote'],
    } as any);

    expect(accountSettingsModule.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        credentials,
        mode: 'blocking',
        refresh: 'force',
      }),
    );
  });

  it('starts Claude with the cached fast account settings snapshot without waiting for refresh', async () => {
    const credentials = { token: 'x' } as any;
    const cachedSettings = { schemaVersion: 6, marker: 'cached-settings' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);

    let refreshed = false;
    const whenRefreshed = new Promise<any>(() => {});

    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockImplementation(({ settings }: any) => ({ marker: settings?.marker }));
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'cache',
      settings: cachedSettings,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed,
    } as any);

    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockImplementation(async (_credentials: any, options: any) => {
      expect(refreshed).toBe(false);
      expect(options.accountSettings).toBe(cachedSettings);
      expect(options.claudeRemoteMetaDefaults).toEqual({ marker: 'cached-settings' });
    });

    const commandPromise = handleClaudeCliCommand({
      args: [],
      terminalRuntime: null,
      rawArgv: ['happier'],
    } as any);

    await commandPromise;
    expect(runSpy).toHaveBeenCalled();
  });
});
