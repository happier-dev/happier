import { afterEach, describe, expect, it, vi } from 'vitest';

const { runSessionCommandSpy } = vi.hoisted(() => ({
  runSessionCommandSpy: vi.fn(),
}));
const { authAndSetupMachineIfNeededMock, readCredentialsMock } = vi.hoisted(() => ({
  authAndSetupMachineIfNeededMock: vi.fn(),
  readCredentialsMock: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    runSessionCommand: (...args: unknown[]) => runSessionCommandSpy(...args),
  }),
}));
vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: (...args: unknown[]) => authAndSetupMachineIfNeededMock(...args),
}));
vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));

import { handleCodexCliCommand } from './command';
import * as runCodexModule from '@/backends/codex/bindings/session';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { type Credentials } from '@/persistence';

afterEach(() => {
  vi.restoreAllMocks();
  runSessionCommandSpy.mockReset();
  authAndSetupMachineIfNeededMock.mockReset();
  readCredentialsMock.mockReset();
});

describe('handleCodexCliCommand', () => {
  const prevAccountSettingsMode = process.env.HAPPIER_ACCOUNT_SETTINGS_MODE;

  afterEach(() => {
    if (typeof prevAccountSettingsMode === 'string') {
      process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = prevAccountSettingsMode;
    } else {
      delete process.env.HAPPIER_ACCOUNT_SETTINGS_MODE;
    }
  });

  it('exits when --happy-starting-mode is invalid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);
    const output = captureConsoleText();

    try {
      await expect(
        handleCodexCliCommand({
          args: ['--happy-starting-mode', 'nope'],
          terminalRuntime: null,
        } as any),
      ).rejects.toThrow('exit:1');
      expect(output.text()).toContain('Invalid --happy-starting-mode');
    } finally {
      exitSpy.mockRestore();
      output.restore();
    }
  });

  it('routes valid terminal runtime mode and resume/session flags through the shared session bridge', async () => {
    process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = 'never';
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    readCredentialsMock.mockResolvedValue(null);
    authAndSetupMachineIfNeededMock.mockResolvedValue({ credentials } as any);
    const runSpy = vi.spyOn(runCodexModule, 'runCodex').mockResolvedValue();
    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleCodexCliCommand({
      args: ['--happy-starting-mode', 'remote', '--existing-session', 'sid-1', '--resume', 'resume-1'],
      terminalRuntime: null,
    } as any);

    expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledTimes(1);
    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      credentials,
      existingSessionId: 'sid-1',
      resume: 'resume-1',
      startingMode: 'remote',
    }));
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('ignores missing values for existing-session/resume flags', async () => {
    process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = 'never';
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    readCredentialsMock.mockResolvedValue(null);
    authAndSetupMachineIfNeededMock.mockResolvedValue({ credentials } as any);
    const runSpy = vi.spyOn(runCodexModule, 'runCodex').mockResolvedValue();
    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleCodexCliCommand({
      args: ['--existing-session', '--resume', '--happy-starting-mode', 'terminal'],
      terminalRuntime: null,
    } as any);

    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      existingSessionId: undefined,
      resume: undefined,
      startingMode: 'local',
    }));
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('forwards explicit working directory aliases through the shared session bridge', async () => {
    process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = 'never';
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    readCredentialsMock.mockResolvedValue(null);
    authAndSetupMachineIfNeededMock.mockResolvedValue({ credentials } as any);
    const runSpy = vi.spyOn(runCodexModule, 'runCodex').mockResolvedValue();
    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleCodexCliCommand({
      args: ['-C', '/tmp/from-short-flag', '--cd', '/tmp/from-long-flag'],
      terminalRuntime: null,
    } as any);

    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      credentials,
      directory: '/tmp/from-long-flag',
    }));
    expect(runSpy).not.toHaveBeenCalled();
  });
});
