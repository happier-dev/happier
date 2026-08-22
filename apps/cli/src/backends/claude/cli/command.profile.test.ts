import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleClaudeCliCommand } from './command';
import * as runClaudeModule from '@/backends/claude/runClaude';
import * as ensureDaemonModule from '@/daemon/ensureDaemon';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import * as providerSettingsModule from '@/settings/providerSettings';
import * as authModule from '@/ui/auth';
import * as directConnectedServicesModule from '@/cli/connectedServices/resolveDirectConnectedServiceEnvironment';
import { logger } from '@/ui/logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleClaudeCliCommand --profile', () => {
  it('materializes the configured Connected Services default before starting Claude', async () => {
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(ensureDaemonModule, 'shouldAutoStartDaemonAfterAuth').mockReturnValue(false);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'cache',
      settings: {
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            claude: {
              v: 1,
              bindingsByServiceId: {
                'claude-subscription': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'team',
                },
              },
            },
          },
        },
      },
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    const cleanup = vi.fn();
    const materialize = vi.spyOn(
      directConnectedServicesModule,
      'resolveDirectConnectedServiceEnvironment',
    ).mockResolvedValue({
      env: { CONNECTED_SERVICE_CLAUDE_TEST: 'selected' },
      cleanupOnFailure: cleanup,
      cleanupOnExit: cleanup,
    });
    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockImplementation(async () => {
      expect(process.env.CONNECTED_SERVICE_CLAUDE_TEST).toBe('selected');
    });

    await handleClaudeCliCommand({
      args: ['claude'],
      rawArgv: ['happier', 'claude'],
      terminalRuntime: null,
    } as any);

    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude',
      connectedServices: expect.objectContaining({
        bindingsByServiceId: expect.objectContaining({
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        }),
      }),
    }));
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(process.env.CONNECTED_SERVICE_CLAUDE_TEST).toBeUndefined();
  });

  it('logs fatal run errors to the file logger before exiting', async () => {
    const fatalError = new Error('startup side effect failed');
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(ensureDaemonModule, 'shouldAutoStartDaemonAfterAuth').mockReturnValue(false);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {},
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    vi.spyOn(runClaudeModule, 'runClaude').mockRejectedValue(fatalError);
    const loggerSpy = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit:1');
    }) as typeof process.exit);

    try {
      await expect(handleClaudeCliCommand({
        args: ['--started-by', 'daemon', '--happy-starting-mode', 'remote'],
        rawArgv: ['happier', '--started-by', 'daemon', '--happy-starting-mode', 'remote'],
        terminalRuntime: null,
      } as any)).rejects.toThrow('exit:1');

      expect(loggerSpy).toHaveBeenCalledWith(fatalError);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

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

  it('treats --permission-mode=<value> as an explicit override so profile seeds do not replace it', async () => {
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
            permissionMode: 'default',
          },
        ],
      },
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--profile', 'work', '--permission-mode=bypassPermissions'],
      rawArgv: ['happier', '--profile', 'work', '--permission-mode=bypassPermissions'],
      terminalRuntime: null,
    } as any);

    const passedOptions = runSpy.mock.calls[0]?.[1] as any;
    expect(passedOptions?.permissionMode).toBe('bypassPermissions');

    const claudeArgs = Array.isArray(passedOptions?.claudeArgs) ? passedOptions.claudeArgs : [];
    expect(claudeArgs).not.toContain('--permission-mode=bypassPermissions');
  });
});
