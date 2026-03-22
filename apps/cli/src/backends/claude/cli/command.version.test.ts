import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleClaudeCliCommand } from './command';
import * as authModule from '@/ui/auth';
import * as runClaudeModule from '@/backends/claude/runClaude';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import * as providerSettingsModule from '@/settings/providerSettings';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleClaudeCliCommand --version', () => {
  it('does not initialize auth/session for version-only invocation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } as any } as any);
    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({} as any);

    await handleClaudeCliCommand({
      args: ['--version'],
      terminalRuntime: null,
      rawArgv: ['happier', '--version'],
    } as any);

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^happier version:/));
    expect(authSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
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
      source: 'none',
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
