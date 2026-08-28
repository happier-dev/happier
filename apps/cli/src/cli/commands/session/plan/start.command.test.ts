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

describe('happier session plan start command', () => {
  beforeEach(() => {
    execute.mockReset();
    createCliActionExecutor.mockClear();
    createCliActionExecutorFromCredentials.mockClear();
    resolveSessionTarget.mockReset();
    fetchSessionById.mockReset();
    resolveSessionIdOrPrefix.mockReset();
    ensureCliActionPolicySettings.mockReset();
    fetchAccountEncryptionCurrentness.mockReset();

    resolveSessionIdOrPrefix.mockResolvedValue({ ok: true, sessionId: 'sess-plan-1' });
    resolveSessionTarget.mockResolvedValue({ ok: true, sessionId: 'sess-plan-1' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-plan-1',
      dataEncryptionKey: null,
    });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain' });
  });

  it('prints a failure envelope when the action executor returns a nested failure payload', async () => {
    execute.mockImplementation(async (actionId: string) => {
      if (actionId === 'action.options.resolve') {
        return {
          ok: true,
          result: {
            actionId: 'subagents.plan.start',
            fieldPath: 'backendTargetKeys',
            optionsSourceId: 'execution.backends.enabled',
            options: [{ value: 'agent:claude', label: 'Claude' }],
          },
        };
      }
      return {
        ok: true,
        result: {
          ok: false,
          errorCode: 'execution_run_failed',
          message: 'execution run failed before start',
        },
      };
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
          '--machine-id',
          'machine-plan',
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

      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_plan_start',
        error: {
          code: 'execution_run_failed',
          message: 'execution run failed before start',
        },
      });
      expect(execute).toHaveBeenNthCalledWith(
        1,
        'action.options.resolve',
        {
          actionId: 'subagents.plan.start',
          fieldPath: 'backendTargetKeys',
          optionsSourceId: 'execution.backends.enabled',
          sessionId: 'sess-plan-1',
          includeDisabled: true,
        },
        { surface: 'cli', defaultSessionId: 'sess-plan-1' },
      );
      expect(execute).toHaveBeenNthCalledWith(
        2,
        'subagents.plan.start',
        {
          backendTargetKeys: ['agent:claude'],
          instructions: 'Plan.',
        },
        { defaultSessionId: 'sess-plan-1' },
      );
      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledWith({
        credentials: expect.objectContaining({ credentialProvenance: 'api_token' }),
        machineId: 'machine-plan',
      });
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-plan');
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(resolveSessionIdOrPrefix).not.toHaveBeenCalled();
      expect(fetchSessionById).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it.each([
    ['unknown option', ['plan', 'start', 'sess', '--backends', 'codex', '--instructions', 'Plan.', '--bogus']],
    ['missing machine value', ['plan', 'start', 'sess', '--backends', 'codex', '--instructions', 'Plan.', '--machine-id', '--json']],
  ])('rejects %s before credential or Action work', async (_name, argv) => {
    const { cmdSessionPlanStart } = await import('./start');
    const readCredentialsFn = vi.fn();
    await expect(cmdSessionPlanStart(argv, { readCredentialsFn })).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(createCliActionExecutorFromCredentials).not.toHaveBeenCalled();
  });
});
