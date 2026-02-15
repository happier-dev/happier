import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleClaudeCliCommand } from './command';
import * as authModule from '@/ui/auth';
import * as runClaudeModule from '@/backends/claude/runClaude';
import * as persistenceModule from '@/persistence';

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
});
