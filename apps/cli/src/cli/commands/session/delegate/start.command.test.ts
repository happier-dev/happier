import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { handleSessionCommand } from '../handleSessionCommand';

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

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

type BackendOption = Readonly<{
  value: string;
  label: string;
  disabled?: boolean;
}>;

function mockActionExecution(options: readonly BackendOption[]): void {
  execute.mockImplementation(async (actionId: string) => {
    if (actionId === 'action.options.resolve') {
      return {
        ok: true,
        result: {
          actionId: 'subagents.delegate.start',
          fieldPath: 'backendTargetKeys',
          optionsSourceId: 'execution.backends.enabled',
          options,
        },
      };
    }
    if (actionId === 'subagents.delegate.start') {
      return {
        ok: true,
        result: { results: [{ key: 'agent:com.acme.agent/acme' }] },
      };
    }
    throw new Error(`Unexpected action: ${actionId}`);
  });
}

describe('happier session delegate start command', () => {
  beforeEach(() => {
    execute.mockReset();
    createCliActionExecutor.mockClear();
    createCliActionExecutorFromCredentials.mockClear();
    resolveSessionTarget.mockReset();
    fetchSessionById.mockReset();
    resolveSessionIdOrPrefix.mockReset();
    ensureCliActionPolicySettings.mockReset();
    fetchAccountEncryptionCurrentness.mockReset();

    resolveSessionIdOrPrefix.mockResolvedValue({ ok: true, sessionId: 'sess-delegate-1' });
    resolveSessionTarget.mockResolvedValue({ ok: true, sessionId: 'sess-delegate-1' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-delegate-1',
      dataEncryptionKey: null,
    });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain' });
  });

  it.each([
    {
      name: 'resolves an installed Agent display name without fabricating a target key',
      agent: 'Acme Agent',
      options: [{ value: 'agent:com.acme.agent/acme', label: 'Acme Agent' }],
      expectedKey: 'agent:com.acme.agent/acme',
    },
    {
      name: 'projects a legacy Agent key onto the current catalog target',
      agent: 'agent:codex',
      options: [{ value: 'agent:happier.agent.codex/codex', label: 'Codex' }],
      expectedKey: 'agent:happier.agent.codex/codex',
    },
    {
      name: 'rejects an absent Agent',
      agent: 'Missing Agent',
      options: [],
      expectedError: 'no matching target',
    },
    {
      name: 'rejects a disabled Agent',
      agent: 'Acme Agent',
      options: [{ value: 'agent:com.acme.agent/acme', label: 'Acme Agent', disabled: true }],
      expectedError: 'disabled',
    },
    {
      name: 'rejects an ambiguous Agent display name',
      agent: 'Agent',
      options: [
        { value: 'agent:com.acme.agent/one', label: 'Agent' },
        { value: 'agent:com.acme.agent/two', label: 'Agent' },
      ],
      expectedError: 'ambiguous',
    },
  ])('$name', async ({ agent, options, expectedKey, expectedError }) => {
    mockActionExecution(options);
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['delegate', 'start', 'sess-delegate', '--agent', agent, 'Delegate.', '--json'],
        { readCredentialsFn: async () => credentials },
      );

      expect(execute).toHaveBeenNthCalledWith(
        1,
        'action.options.resolve',
        {
          actionId: 'subagents.delegate.start',
          fieldPath: 'backendTargetKeys',
          optionsSourceId: 'execution.backends.enabled',
          sessionId: 'sess-delegate-1',
          includeDisabled: true,
        },
        { surface: 'cli', defaultSessionId: 'sess-delegate-1' },
      );

      if (expectedKey) {
        expect(execute).toHaveBeenNthCalledWith(
          2,
          'subagents.delegate.start',
          {
            backendTargetKeys: [expectedKey],
            instructions: 'Delegate.',
          },
          { defaultSessionId: 'sess-delegate-1' },
        );
        expect(output.json()).toEqual(expect.objectContaining({
          ok: true,
          kind: 'session_delegate_start',
        }));
      } else {
        if (!expectedError) throw new Error('Missing expected backend resolution error');
        expect(execute).toHaveBeenCalledTimes(1);
        expect(output.json()).toEqual(expect.objectContaining({
          ok: false,
          kind: 'session_delegate_start',
          error: expect.objectContaining({
            code: 'invalid_arguments',
            message: expect.stringContaining(expectedError),
          }),
        }));
      }
    } finally {
      output.restore();
    }
  });

  it('selects the credential-aware Action executor before any legacy Session bootstrap for API tokens', async () => {
    mockActionExecution([{ value: 'agent:com.acme.agent/acme', label: 'Acme Agent' }]);
    const apiTokenCredentials = {
      token: 'hap_v1_token_secret',
      encryption: null,
      credentialProvenance: 'api_token' as const,
    };
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        [
          'delegate',
          'start',
          'sess-delegate',
          '--agent',
          'Acme Agent',
          'Delegate.',
          '--machine-id',
          'machine-selected',
          '--json',
        ],
        { readCredentialsFn: async () => apiTokenCredentials },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledWith({
        credentials: apiTokenCredentials,
        machineId: 'machine-selected',
      });
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-delegate');
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(resolveSessionIdOrPrefix).not.toHaveBeenCalled();
      expect(fetchSessionById).not.toHaveBeenCalled();
      expect(execute).toHaveBeenNthCalledWith(
        1,
        'action.options.resolve',
        {
          actionId: 'subagents.delegate.start',
          fieldPath: 'backendTargetKeys',
          optionsSourceId: 'execution.backends.enabled',
          sessionId: 'sess-delegate-1',
          includeDisabled: true,
        },
        { surface: 'cli', defaultSessionId: 'sess-delegate-1' },
      );
      expect(execute).toHaveBeenNthCalledWith(
        2,
        'subagents.delegate.start',
        {
          backendTargetKeys: ['agent:com.acme.agent/acme'],
          instructions: 'Delegate.',
        },
        { defaultSessionId: 'sess-delegate-1' },
      );
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_delegate_start',
        data: expect.objectContaining({ sessionId: 'sess-delegate-1' }),
      }));
    } finally {
      output.restore();
    }
  });
});
