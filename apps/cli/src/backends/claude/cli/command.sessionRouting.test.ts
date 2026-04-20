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
import * as resolveRequestedSessionDirectoryModule from '@/agent/runtime/resolveRequestedSessionDirectory';

afterEach(() => {
  vi.restoreAllMocks();
  runSessionCommandSpy.mockReset();
});

describe('handleClaudeCliCommand session routing', () => {
  it('routes terminal session startup through the shared session bridge', async () => {
    process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = 'never';

    const credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(null);
    vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    vi.spyOn(resolveRequestedSessionDirectoryModule, 'resolveRequestedSessionDirectory').mockReturnValue('/tmp/claude-requested');
    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--happy-starting-mode', 'terminal', '--existing-session', 'sid-1', '--resume', 'resume-1'],
      terminalRuntime: null,
      rawArgv: ['happier', '--happy-starting-mode', 'terminal', '--existing-session', 'sid-1', '--resume', 'resume-1'],
    } as any);

    expect(runSessionCommandSpy).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        credentials,
        directory: '/tmp/claude-requested',
        startingMode: 'terminal',
        existingSessionId: 'sid-1',
        resume: 'resume-1',
      }),
    );
  });
});
