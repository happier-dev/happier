import { afterEach, describe, expect, it, vi } from 'vitest';

const { runSessionCommandSpy } = vi.hoisted(() => ({
  runSessionCommandSpy: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    runSessionCommand: (...args: unknown[]) => runSessionCommandSpy(...args),
  }),
}));

import { handleGeminiCliCommand } from './command';
import * as authModule from '@/ui/auth';
import * as persistenceModule from '@/persistence';
import { type Credentials } from '@/persistence';

afterEach(() => {
  vi.restoreAllMocks();
  runSessionCommandSpy.mockReset();
});

describe('handleGeminiCliCommand (session)', () => {
  const prevAccountSettingsMode = process.env.HAPPIER_ACCOUNT_SETTINGS_MODE;

  afterEach(() => {
    if (typeof prevAccountSettingsMode === 'string') {
      process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = prevAccountSettingsMode;
    } else {
      delete process.env.HAPPIER_ACCOUNT_SETTINGS_MODE;
    }
  });

  it('routes sessions through the shared session bridge (no legacy runGemini runner)', async () => {
    process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = 'never';

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(null);
    vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleGeminiCliCommand({
      args: ['gemini', '--existing-session', 'sid-1', '--resume', 'resume-1'],
      terminalRuntime: null,
    } as any);

    expect(runSessionCommandSpy).toHaveBeenCalledWith('gemini', expect.objectContaining({
      credentials,
      existingSessionId: 'sid-1',
      resume: 'resume-1',
    }));
  });
});
