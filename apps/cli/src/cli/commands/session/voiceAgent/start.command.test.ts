import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutor = vi.fn(() => ({ execute }));
const resolveSessionTarget = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({
  execute,
  resolveSessionTarget,
}));
const fetchSessionById = vi.fn();
const resolveSessionIdOrPrefix = vi.fn();
const ensureCliActionPolicySettings = vi.fn();
const fetchAccountEncryptionCurrentness = vi.fn();

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
}));

vi.mock('@/session/query/resolveSessionId', () => ({
  resolveSessionIdOrPrefix,
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  resolveSessionEncryptionContextFromCredentials: vi.fn(() => ({ kind: 'legacy' })),
  resolveSessionStoredContentEncryptionMode: vi.fn(() => 'legacy'),
}));

vi.mock('@/session/actions/ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness,
}));

describe('happier session voice-agent start command', () => {
  beforeEach(() => {
    execute.mockReset();
    createCliActionExecutor.mockClear();
    createCliActionExecutorFromCredentials.mockClear();
    resolveSessionTarget.mockReset();
    fetchSessionById.mockReset();
    resolveSessionIdOrPrefix.mockReset();
    ensureCliActionPolicySettings.mockReset();
    fetchAccountEncryptionCurrentness.mockReset();

    resolveSessionIdOrPrefix.mockResolvedValue({ ok: true, sessionId: 'sess-voice-1' });
    resolveSessionTarget.mockResolvedValue({ ok: true, sessionId: 'sess-voice-1' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-voice-1',
      dataEncryptionKey: null,
    });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain' });
  });

  it('resolves the requested backend through the voice action options source', async () => {
    execute.mockImplementation(async (actionId: string) => {
      if (actionId === 'action.options.resolve') {
        return {
          ok: true,
          result: {
            actionId: 'voice_agent.start',
            fieldPath: 'backendTargetKeys',
            optionsSourceId: 'execution.backends.enabled',
            options: [{ value: 'agent:com.acme.agent/acme', label: 'Acme Agent' }],
          },
        };
      }
      return {
        ok: true,
        result: { results: [{ key: 'agent:com.acme.agent/acme' }] },
      };
    });

    const { cmdSessionVoiceAgentStart } = await import('./start');
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionVoiceAgentStart(
        [
          'voice-agent',
          'start',
          'sess-voice',
          '--backends',
          'Acme Agent',
          '--instructions',
          'Voice.',
          '--json',
        ],
        {
          readCredentialsFn: async () => ({
            token: 'hap_v1_token_secret',
            encryption: null,
            credentialProvenance: 'api_token' as const,
          }),
        },
      );

      expect(execute).toHaveBeenNthCalledWith(
        1,
        'action.options.resolve',
        {
          actionId: 'voice_agent.start',
          fieldPath: 'backendTargetKeys',
          optionsSourceId: 'execution.backends.enabled',
          sessionId: 'sess-voice-1',
          includeDisabled: true,
        },
        { surface: 'cli', defaultSessionId: 'sess-voice-1' },
      );
      expect(execute).toHaveBeenNthCalledWith(
        2,
        'voice_agent.start',
        {
          backendTargetKeys: ['agent:com.acme.agent/acme'],
          instructions: 'Voice.',
        },
        { defaultSessionId: 'sess-voice-1' },
      );
      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-voice');
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(resolveSessionIdOrPrefix).not.toHaveBeenCalled();
      expect(fetchSessionById).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_voice_agent_start',
      }));
    } finally {
      output.restore();
    }
  });
});
