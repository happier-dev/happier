import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const {
  createCliActionExecutor,
  createCliActionExecutorFromCredentials,
  ensureCliActionPolicySettings,
  execute,
  resolveSessionIdOrPrefix,
  resolveSessionTarget,
  resolveSessionTransportContext,
} = vi.hoisted(() => {
  const execute = vi.fn();
  const resolveSessionTarget = vi.fn();
  return {
    createCliActionExecutor: vi.fn(() => ({
      execute: vi.fn(async () => ({
        ok: false,
        errorCode: 'local_executor_used',
        error: 'local_executor_used',
      })),
    })),
    createCliActionExecutorFromCredentials: vi.fn(() => ({ execute, resolveSessionTarget })),
    ensureCliActionPolicySettings: vi.fn(async () => undefined),
    execute,
    resolveSessionIdOrPrefix: vi.fn(),
    resolveSessionTarget,
    resolveSessionTransportContext: vi.fn(async () => ({
      ok: false,
      code: 'local_session_transport_used',
    })),
  };
});

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

vi.mock('@/session/actions/ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/session/query/resolveSessionId', () => ({
  resolveSessionIdOrPrefix,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

import { cmdSessionActionsExecute } from './execute';

describe('session actions execute with an API token', () => {
  beforeEach(() => {
    createCliActionExecutor.mockClear();
    createCliActionExecutorFromCredentials.mockClear();
    ensureCliActionPolicySettings.mockClear();
    execute.mockReset();
    resolveSessionIdOrPrefix.mockReset();
    resolveSessionTarget.mockReset();
    resolveSessionTransportContext.mockClear();
  });

  it('resolves an E2EE-capable selector through the PAT Action adapter before legacy Session lookup', async () => {
    const credentials = {
      token: 'hap_v1_pat_secret',
      encryption: null,
      credentialProvenance: 'api_token' as const,
    };
    resolveSessionIdOrPrefix.mockResolvedValueOnce({
      ok: true,
      sessionId: 'session_exact_123',
    });
    resolveSessionTarget.mockResolvedValueOnce({
      ok: true,
      sessionId: 'session_exact_123',
    });
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'idle' },
    });

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionActionsExecute(
        ['actions', 'execute', 'e2ee-active-tag', 'session.status.get', '--json'],
        { readCredentialsFn: async () => credentials },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledWith({ credentials });
      expect(resolveSessionTarget).toHaveBeenCalledWith('e2ee-active-tag');
      expect(resolveSessionIdOrPrefix).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'session.status.get',
        { sessionId: 'session_exact_123' },
        {
          defaultSessionId: 'session_exact_123',
          surface: 'cli',
        },
      );
      expect(output.json()).toEqual({
        v: 1,
        ok: true,
        kind: 'session_actions_execute',
        data: {
          sessionId: 'session_exact_123',
          actionId: 'session.status.get',
          result: { status: 'idle' },
        },
      });
    } finally {
      output.restore();
    }
  });
});
