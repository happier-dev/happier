import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutor = vi.fn(() => ({ execute }));
const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-1' }));
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));
vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

const resolveSessionTransportContext = vi.fn(async () => ({
  ok: true,
  sessionId: 'sess-1',
  rawSession: { id: 'sess-1', active: true, metadata: {} },
  ctx: null,
  mode: 'plain' as const,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

const ensureCliActionPolicySettings = vi.fn(async () => {});
vi.mock('@/session/actions/ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

describe('happier session run start (action executor)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionTarget.mockResolvedValue({ ok: true, sessionId: 'sess-1' });
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, runId: 'run-1' },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        [
          'run',
          'start',
          'sess-1',
          '--intent',
          'review',
          '--agent',
          'agent:claude',
          '--permission-mode',
          'read_only',
          '--retention',
          'ephemeral',
          '--run-class',
          'bounded',
          '--io-mode',
          'request_response',
          '--json',
        ],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'execution.run.start',
        {
          sessionId: 'sess-1',
          intent: 'review',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        { surface: 'cli', defaultSessionId: 'sess-1' },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_start',
        data: expect.objectContaining({
          sessionId: 'sess-1',
          runId: 'run-1',
        }),
      }));
    } finally {
      output.restore();
    }
  });

  it('selects the public Action transport before legacy Session bootstrap for API tokens', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { ok: true, runId: 'run-1' } });

    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'start', 'sess-1', '--intent', 'review', '--agent', 'agent:claude', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'hap_v1_token_secret',
            encryption: null,
            credentialProvenance: 'api_token' as const,
          }),
        },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_run_start' }));
    } finally {
      output.restore();
    }
  });
});
