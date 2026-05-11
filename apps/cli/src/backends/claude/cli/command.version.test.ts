import { afterEach, describe, expect, it, vi } from 'vitest';

const { runSessionCommandSpy } = vi.hoisted(() => ({
  runSessionCommandSpy: vi.fn(),
}));
const { execFileSyncSpy } = vi.hoisted(() => ({
  execFileSyncSpy: vi.fn(() => '1.2.3\n'),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    runSessionCommand: (...args: unknown[]) => runSessionCommandSpy(...args),
  }),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: execFileSyncSpy,
  };
});
vi.mock('@/packagedRuntime/managedTools/requireProviderCliLaunchSpec', () => ({
  requireProviderCliLaunchSpec: () => ({
    source: 'path',
    resolvedPath: '/usr/local/bin/claude',
    command: '/usr/local/bin/claude',
    args: [],
  }),
}));

import { handleClaudeCliCommand } from './command';
import * as authModule from '@/ui/auth';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';

afterEach(() => {
  vi.restoreAllMocks();
  runSessionCommandSpy.mockReset();
  execFileSyncSpy.mockClear();
});

describe('handleClaudeCliCommand --version', () => {
  it('passes version-only invocation through to Claude without initializing auth/session', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } as any } as any);
    const readSettingsSpy = vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({} as any);

    await handleClaudeCliCommand({
      args: ['--version'],
      terminalRuntime: null,
      rawArgv: ['happier', '--version'],
    } as any);

    expect(execFileSyncSpy).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      ['--version'],
      expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
    );
    expect(logSpy).toHaveBeenCalledWith('1.2.3');
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

  it('fails closed when --js-runtime is followed by another flag instead of a runtime name', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);

    try {
      await expect(handleClaudeCliCommand({
        args: ['--js-runtime', '--permission-mode', 'plan'],
        terminalRuntime: null,
        rawArgv: ['happier', '--js-runtime', '--permission-mode', 'plan'],
      } as any)).rejects.toThrow('exit:1');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing value for --js-runtime'));
      expect(runSessionCommandSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('ignores obsolete child account settings version hints for daemon-started Claude sessions', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'network',
      settings: {} as any,
      settingsVersion: 14,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--started-by', 'daemon', '--happy-starting-mode', 'remote', '--account-settings-version-hint', '14'],
      terminalRuntime: null,
      rawArgv: ['happier', '--started-by', 'daemon', '--happy-starting-mode', 'remote', '--account-settings-version-hint', '14'],
    } as any);

    expect(accountSettingsModule.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        credentials,
        mode: 'blocking',
        refresh: 'force',
      }),
    );
    expect(accountSettingsModule.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
      expect.not.objectContaining({
        minSettingsVersion: expect.any(Number),
      }),
    );
    expect(runSessionCommandSpy).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ credentials, startedBy: 'daemon', startingMode: 'remote' }),
    );
    expect(runSessionCommandSpy.mock.calls[0]?.[1]).not.toHaveProperty('claudeArgs');
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
