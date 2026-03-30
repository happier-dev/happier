import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleOpenCodeCliCommand } from './command';
import * as authModule from '@/ui/auth';
import * as runOpenCodeModule from '@/backends/opencode/runOpenCode';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { type Credentials } from '@/persistence';
import * as persistenceModule from '@/persistence';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleOpenCodeCliCommand', () => {
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
        handleOpenCodeCliCommand({
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

  it('passes valid starting mode and resume/session flags to runOpenCode', async () => {
    process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = 'never';
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(null);
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
