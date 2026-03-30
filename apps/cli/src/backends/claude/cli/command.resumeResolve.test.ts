import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleClaudeCliCommand } from './command';
import * as runClaudeModule from '@/backends/claude/runClaude';
import * as ensureDaemonModule from '@/daemon/ensureDaemon';
import * as persistenceModule from '@/persistence';
import * as providerSettingsModule from '@/settings/providerSettings';
import * as sessionsHttpModule from '@/session/transport/http/sessionsHttp';
import * as resumeCommandModule from '@/cli/commands/resume';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleClaudeCliCommand --resume (best-effort Happier id resolution)', () => {
  it('delegates to `happier resume <id>` for implicit Claude invocations when the id is a Happier session id without a cm prefix', async () => {
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(ensureDaemonModule, 'shouldAutoStartDaemonAfterAuth').mockReturnValue(false);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});

    vi.spyOn(sessionsHttpModule, 'fetchSessionById').mockResolvedValue({
      id: 'session_happy_123',
      createdAt: 0,
      updatedAt: 0,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '/tmp/project',
        claudeSessionId: '00000000-0000-0000-0000-000000000000',
      }),
    } as any);

    const resumeSpy = vi.spyOn(resumeCommandModule, 'handleResumeCommand').mockResolvedValue(undefined);
    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--resume', 'session_happy_123'],
      rawArgv: ['happier', '--resume', 'session_happy_123'],
      terminalRuntime: null,
    } as any);

    expect(resumeSpy).toHaveBeenCalledWith(
      ['session_happy_123'],
      expect.objectContaining({
        rawArgv: ['happier', '--resume', 'session_happy_123'],
        terminalRuntime: null,
      }),
    );
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('delegates to `happier resume <id>` for implicit Claude invocations when the id is a Happier session id', async () => {
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(ensureDaemonModule, 'shouldAutoStartDaemonAfterAuth').mockReturnValue(false);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});

    vi.spyOn(sessionsHttpModule, 'fetchSessionById').mockResolvedValue({
      id: 'cmm_test_happy_123',
      createdAt: 0,
      updatedAt: 0,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '/tmp/project',
        claudeSessionId: '00000000-0000-0000-0000-000000000000',
      }),
    } as any);

    const resumeSpy = vi.spyOn(resumeCommandModule, 'handleResumeCommand').mockResolvedValue(undefined);
    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--resume', 'cmm_test_happy_123'],
      rawArgv: ['happier', '--resume', 'cmm_test_happy_123'],
      terminalRuntime: null,
    } as any);

    expect(resumeSpy).toHaveBeenCalledWith(
      ['cmm_test_happy_123'],
      expect.objectContaining({
        rawArgv: ['happier', '--resume', 'cmm_test_happy_123'],
        terminalRuntime: null,
      }),
    );
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not rewrite resume ids for explicit happier claude invocations', async () => {
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(ensureDaemonModule, 'shouldAutoStartDaemonAfterAuth').mockReturnValue(false);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});

    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['claude', '--resume', 'cmm_test_happy_123'],
      rawArgv: ['happier', 'claude', '--resume', 'cmm_test_happy_123'],
      terminalRuntime: null,
    } as any);

    const passedOptions = runSpy.mock.calls[0]?.[1] as any;
    const claudeArgs = Array.isArray(passedOptions?.claudeArgs) ? passedOptions.claudeArgs : [];
    expect(claudeArgs).toEqual(expect.arrayContaining(['--resume', 'cmm_test_happy_123']));
  });

  it('does not delegate when the resume id is not a Happier session id', async () => {
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as any);
    vi.spyOn(ensureDaemonModule, 'shouldAutoStartDaemonAfterAuth').mockReturnValue(false);
    vi.spyOn(providerSettingsModule, 'resolveProviderOutgoingMessageMetaExtras').mockReturnValue({});

    vi.spyOn(sessionsHttpModule, 'fetchSessionById').mockResolvedValue(null);

    const resumeSpy = vi.spyOn(resumeCommandModule, 'handleResumeCommand').mockResolvedValue(undefined);
    const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockResolvedValue(undefined);

    await handleClaudeCliCommand({
      args: ['--resume', 'cmm_test_happy_123'],
      rawArgv: ['happier', '--resume', 'cmm_test_happy_123'],
      terminalRuntime: null,
    } as any);

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalled();
  });
});
