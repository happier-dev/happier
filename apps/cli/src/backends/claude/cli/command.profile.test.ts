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
import * as ensureDaemonModule from '@/daemon/ensureDaemon';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';

afterEach(() => {
  vi.restoreAllMocks();
  runSessionCommandSpy.mockReset();
});

describe('handleClaudeCliCommand --profile', () => {
  it('applies profile env overlay and does not pass --profile through to Claude', async () => {
    const prevToken = process.env.TEST_PROFILE_TOKEN;
    const prevProfileId = process.env.HAPPIER_SESSION_PROFILE_ID;

    try {
      vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
        token: 'x',
        encryption: { type: 'legacy', secret: new Uint8Array(32) },
      } as any);
      vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
      vi.spyOn(ensureDaemonModule, 'shouldAutoStartDaemonAfterAuth').mockReturnValue(false);
      vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
        source: 'none',
        settings: {
          profiles: [
            {
              id: 'work',
              name: 'Work',
              environmentVariables: [{ name: 'TEST_PROFILE_TOKEN', value: 'shh' }],
            },
          ],
        },
        settingsVersion: 0,
        loadedAtMs: Date.now(),
        whenRefreshed: null,
      } as any);

      runSessionCommandSpy.mockResolvedValue(undefined);

      await handleClaudeCliCommand({
        args: ['--profile', 'work'],
        rawArgv: ['happier', '--profile', 'work'],
        terminalRuntime: null,
      } as any);

      expect(process.env.HAPPIER_SESSION_PROFILE_ID).toBe('work');
      expect(process.env.TEST_PROFILE_TOKEN).toBe('shh');

      const passedOptions = runSessionCommandSpy.mock.calls[0]?.[1] as any;
      const claudeArgs = Array.isArray(passedOptions?.claudeArgs) ? passedOptions.claudeArgs : [];
      expect(claudeArgs).not.toContain('--profile');
      expect(claudeArgs).not.toContain('work');
    } finally {
      if (typeof prevToken === 'string') {
        process.env.TEST_PROFILE_TOKEN = prevToken;
      } else {
        delete process.env.TEST_PROFILE_TOKEN;
      }

      if (typeof prevProfileId === 'string') {
        process.env.HAPPIER_SESSION_PROFILE_ID = prevProfileId;
      } else {
        delete process.env.HAPPIER_SESSION_PROFILE_ID;
      }
    }
  });

  it('treats --permission-mode=<value> as an explicit override so profile seeds do not replace it', async () => {
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(ensureDaemonModule, 'shouldAutoStartDaemonAfterAuth').mockReturnValue(false);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {
        profiles: [
          {
            id: 'work',
            name: 'Work',
            permissionMode: 'default',
          },
        ],
      },
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    runSessionCommandSpy.mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--profile', 'work', '--permission-mode=bypassPermissions'],
      rawArgv: ['happier', '--profile', 'work', '--permission-mode=bypassPermissions'],
      terminalRuntime: null,
    } as any);

    const passedOptions = runSessionCommandSpy.mock.calls[0]?.[1] as any;
    // The shared session-start parser canonicalizes historical aliases (bypassPermissions -> yolo).
    expect(passedOptions?.permissionMode).toBe('yolo');

    const claudeArgs = Array.isArray(passedOptions?.claudeArgs) ? passedOptions.claudeArgs : [];
    expect(claudeArgs).not.toContain('--permission-mode=bypassPermissions');
  });
});
