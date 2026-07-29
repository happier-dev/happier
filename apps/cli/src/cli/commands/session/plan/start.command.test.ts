import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutor = vi.fn(() => ({ execute }));
const fetchSessionById = vi.fn();
const resolveSessionIdOrPrefix = vi.fn();
const ensureCliActionPolicySettings = vi.fn();

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
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

describe('happier session plan start command', () => {
  beforeEach(() => {
    execute.mockReset();
    createCliActionExecutor.mockClear();
    fetchSessionById.mockReset();
    resolveSessionIdOrPrefix.mockReset();
    ensureCliActionPolicySettings.mockReset();

    resolveSessionIdOrPrefix.mockResolvedValue({ ok: true, sessionId: 'sess-plan-1' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-plan-1',
      dataEncryptionKey: null,
    });
  });

  it('prints a failure envelope when the action executor returns a nested failure payload', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: false,
        errorCode: 'execution_run_failed',
        message: 'execution run failed before start',
      },
    });

    const { cmdSessionPlanStart } = await import('./start');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionPlanStart(
        [
          'plan',
          'start',
          'sess-plan',
          '--backends',
          'claude',
          '--instructions',
          'Plan.',
          '--json',
        ],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_plan_start',
        error: {
          code: 'execution_run_failed',
          message: 'execution run failed before start',
        },
      });
    } finally {
      output.restore();
    }
  });
});
