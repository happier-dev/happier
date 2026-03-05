import { afterEach, describe, expect, it, vi } from 'vitest';

import { runBackendSessionCliCommand } from './runBackendSessionCliCommand';
import * as authModule from '@/ui/auth';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runBackendSessionCliCommand', () => {
  function makeJwtWithSub(sub: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
    return `${header}.${payload}.signature`;
  }

  it('fast-paths terminal starts by avoiding auth/setup and using fast account settings bootstrap', async () => {
    const credentials = { token: 'x' } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(readCredentialsSpy).toHaveBeenCalled();
    expect(authSpy).not.toHaveBeenCalled();
    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'codex',
        credentials,
        mode: 'fast',
        refresh: 'auto',
      }),
    );
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ credentials }));
  });

  it('waits for refreshed account settings and passes the refreshed snapshot into the run', async () => {
    const credentials = { token: 'x' } as any;

	    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
	    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);

	    let refreshed = false;
      const refreshedSettings = { schemaVersion: 6, marker: 'fresh' } as any;
	    let releaseRefresh: () => void = () => {
	      throw new Error('releaseRefresh called before being initialized');
	    };
	    const whenRefreshed = new Promise<any>((resolve) => {
	      releaseRefresh = () => {
	        refreshed = true;
	        resolve({
	          source: 'network',
          settings: refreshedSettings,
	          settingsVersion: 1,
	          loadedAtMs: Date.now(),
	          whenRefreshed: null,
	        });
	      };
	    });

    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed,
    } as any);

	    const run = vi.fn(async (params: any) => {
	      expect(refreshed).toBe(true);
        expect(params.accountSettingsContext?.settings).toBe(refreshedSettings);
	    });
	    const loadRun = vi.fn().mockResolvedValue(run);

	    const commandPromise = runBackendSessionCliCommand({
	      context: { args: ['gemini'], terminalRuntime: null } as any,
	      loadRun,
	      agentIdForAccountSettings: 'gemini' as any,
	    });

	    // Allow the command to reach the potential wait point.
	    await Promise.resolve();
	    expect(run).not.toHaveBeenCalled();

	    releaseRefresh();
	    await commandPromise;
	    expect(run).toHaveBeenCalled();
	  });

  it('forces a fresh blocking account settings bootstrap for daemon-started sessions', async () => {
    const credentials = { token: 'x' } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--started-by', 'daemon'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(authSpy).not.toHaveBeenCalled();
    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'blocking',
        refresh: 'force',
      }),
    );
  });

  it('forces refresh and waits for Codex account settings before starting for terminal starts', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    let refreshed = false;
    const whenRefreshed = Promise.resolve().then(() => {
      refreshed = true;
      return {
        source: 'network',
        settings: {} as any,
        settingsVersion: 1,
        loadedAtMs: Date.now(),
        whenRefreshed: null,
      };
    });
    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed,
    } as any);

    const run = vi.fn(async () => {
      expect(refreshed).toBe(true);
    });
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--refresh-settings'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'fast',
        refresh: 'force',
      }),
    );
    expect(run).toHaveBeenCalled();
  });

  it('binds machine id selection to decoded token sub when credentials already exist', async () => {
    const credentials = { token: makeJwtWithSub('acct-b') } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    const ensureMachineSpy = vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-acct-b' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(authSpy).not.toHaveBeenCalled();
    expect(ensureMachineSpy).toHaveBeenCalledWith(credentials);
  });

  it('passes provider spawn extras from account settings into the backend run', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'network',
      settings: { codexBackendMode: 'acp' } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ experimentalCodexAcp: true }));
  });

});
