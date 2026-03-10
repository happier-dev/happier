import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleOpenCodeCliCommand } from './command';
import * as authModule from '@/ui/auth';
import * as runOpenCodeModule from '@/backends/opencode/runOpenCode';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleOpenCodeCliCommand', () => {
  it('exits when --happy-starting-mode is invalid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        handleOpenCodeCliCommand({
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

  it('passes valid starting mode and resume/session flags to runOpenCode', async () => {
    const credentials = { token: 't' } as any;
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    const runSpy = vi.spyOn(runOpenCodeModule, 'runOpenCode').mockResolvedValue();

    await handleOpenCodeCliCommand({
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
});
