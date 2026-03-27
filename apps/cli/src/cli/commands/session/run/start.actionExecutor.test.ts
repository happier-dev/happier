import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutor = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

const resolveSessionIdOrPrefix = vi.fn(async () => ({ ok: true, sessionId: 'sess-1' }));
vi.mock('@/session/query/resolveSessionId', () => ({
  resolveSessionIdOrPrefix,
}));

const fetchSessionById = vi.fn(async () => ({ encryptionMode: 'plain' }));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
}));

describe('happier session run start (action executor)', () => {
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
          '--backend',
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

      expect(createCliActionExecutor).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'execution.run.start',
        {
          sessionId: 'sess-1',
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      }));
    } finally {
      output.restore();
    }
  });
});
