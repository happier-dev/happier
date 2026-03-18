import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleClaudeCliCommand } from './command';
import * as runClaudeModule from '@/backends/claude/runClaude';
import * as ensureDaemonModule from '@/daemon/ensureDaemon';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import * as providerSettingsModule from '@/settings/providerSettings';

afterEach(() => {
  vi.restoreAllMocks();
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
      vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});
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

      const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

      await handleClaudeCliCommand({
        args: ['--profile', 'work'],
        rawArgv: ['happier', '--profile', 'work'],
        terminalRuntime: null,
      } as any);

      expect(process.env.HAPPIER_SESSION_PROFILE_ID).toBe('work');
      expect(process.env.TEST_PROFILE_TOKEN).toBe('shh');

      const passedOptions = runSpy.mock.calls[0]?.[1] as any;
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
});

