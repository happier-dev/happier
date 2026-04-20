import { afterEach, describe, expect, it, vi } from 'vitest';

const { runSessionCommandSpy } = vi.hoisted(() => ({
  runSessionCommandSpy: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    runSessionCommand: (...args: unknown[]) => runSessionCommandSpy(...args),
  }),
}));

import { handleClaudeCliCommand } from './command';
import * as authModule from '@/ui/auth';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';

afterEach(() => {
  vi.restoreAllMocks();
  runSessionCommandSpy.mockReset();
});

describe('handleClaudeCliCommand --version', () => {
  it('does not initialize auth/session for version-only invocation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } as any } as any);
    const readSettingsSpy = vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({} as any);

    await handleClaudeCliCommand({
      args: ['--version'],
      terminalRuntime: null,
      rawArgv: ['happier', '--version'],
    } as any);

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^happier version:/));
    expect(readSettingsSpy).not.toHaveBeenCalled();
    expect(authSpy).not.toHaveBeenCalled();
    expect(runSessionCommandSpy).not.toHaveBeenCalled();
  });

  it('routes local terminal invocations through the shared session bridge without blocking on auth/setup', async () => {
    const credentials = { token: 'x' } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);

    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    runSessionCommandSpy.mockResolvedValue(undefined);

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
    expect(runSessionCommandSpy).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ credentials, startedBy: 'terminal' }),
    );
  });

  it('binds existing credentials through the token-aware machine id helper', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    const ensureMachineSpy = vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: [],
      terminalRuntime: null,
      rawArgv: ['happier'],
    } as any);

    expect(ensureMachineSpy).toHaveBeenCalledWith(credentials);
    expect(runSessionCommandSpy).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ credentials, startedBy: 'terminal' }),
    );
  });

  it('uses fast account settings bootstrap even when forcing refresh', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

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
    expect(runSessionCommandSpy).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ credentials, startedBy: 'terminal' }),
    );
  });

  it('uses blocking account settings bootstrap for daemon-started Claude sessions', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--started-by', 'daemon', '--happy-starting-mode', 'remote'],
      terminalRuntime: null,
      rawArgv: ['happier', '--started-by', 'daemon', '--happy-starting-mode', 'remote'],
    } as any);

    expect(accountSettingsModule.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        credentials,
        mode: 'blocking',
        refresh: 'force',
      }),
    );
    expect(runSessionCommandSpy).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ credentials, startedBy: 'daemon', startingMode: 'remote' }),
    );
  });

  it('does not block on account settings bootstrap for terminal remote Claude starts', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--happy-starting-mode', 'remote'],
      terminalRuntime: null,
      rawArgv: ['happier', '--happy-starting-mode', 'remote'],
    } as any);

    expect(accountSettingsModule.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        credentials,
        mode: 'fast',
        refresh: 'auto',
      }),
    );
    expect(runSessionCommandSpy).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ credentials, startedBy: 'terminal', startingMode: 'remote' }),
    );
  });

  it('starts Claude with the cached fast account settings snapshot without waiting for refresh', async () => {
    const credentials = { token: 'x' } as any;
    const cachedSettings = { schemaVersion: 6, marker: 'cached-settings' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);

    let refreshed = false;
    const whenRefreshed = new Promise<any>(() => {});

    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'cache',
      settings: cachedSettings,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed,
    } as any);

    runSessionCommandSpy.mockImplementation(async (_backendId: string, options: any) => {
      expect(refreshed).toBe(false);
      expect(options.accountSettingsContext?.settings).toBe(cachedSettings);
    });

    const commandPromise = handleClaudeCliCommand({
      args: [],
      terminalRuntime: null,
      rawArgv: ['happier'],
    } as any);

    await commandPromise;
    expect(runSessionCommandSpy).toHaveBeenCalled();
  });
});
