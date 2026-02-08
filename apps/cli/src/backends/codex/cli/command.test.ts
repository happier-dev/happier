import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCodexCliCommand } from './command';
import * as authModule from '@/ui/auth';
import * as runCodexModule from '@/backends/codex/runCodex';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleCodexCliCommand', () => {
  it('exits when --happy-starting-mode is invalid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        handleCodexCliCommand({
          args: ['--happy-starting-mode', 'nope'],
          terminalRuntime: null,
        } as any),
      ).rejects.toThrow('exit:1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --happy-starting-mode'));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('passes valid starting mode and resume/session flags to runCodex', async () => {
    const credentials = { token: 't' } as any;
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    const runSpy = vi.spyOn(runCodexModule, 'runCodex').mockResolvedValue();

    await handleCodexCliCommand({
      args: ['--happy-starting-mode', 'remote', '--existing-session', 'sid-1', '--resume', 'resume-1'],
      terminalRuntime: null,
    } as any);

    expect(authSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({
      credentials,
      existingSessionId: 'sid-1',
      resume: 'resume-1',
      startingMode: 'remote',
    }));
  });

  it('ignores missing values for existing-session/resume flags', async () => {
    const credentials = { token: 't' } as any;
    vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    const runSpy = vi.spyOn(runCodexModule, 'runCodex').mockResolvedValue();

    await handleCodexCliCommand({
      args: ['--existing-session', '--resume', '--happy-starting-mode', 'local'],
      terminalRuntime: null,
    } as any);

    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: undefined,
      resume: undefined,
      startingMode: 'local',
    }));
  });
});
