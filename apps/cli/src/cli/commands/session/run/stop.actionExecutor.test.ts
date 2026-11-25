import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-1' }));
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));
const resolveSessionTransportContext = vi.fn();

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

describe('happier session run stop (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, status: 'failed' },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'stop', 'sess-1', 'run-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'execution.run.stop',
        { sessionId: 'sess-1', runId: 'run-1' },
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_stop',
        data: { sessionId: 'sess-1', runId: 'run-1', stopped: false, status: 'failed' },
      }));
    } finally {
      output.restore();
    }
  });

  it('does not resolve an API-token Session through the generic transport', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'stop', 'sess-1', 'run-1', '--json'],
        { readCredentialsFn: async () => ({ token: 'hap_v1_token_secret', encryption: null, credentialProvenance: 'api_token' as const }) },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_run_stop' }));
    } finally {
      output.restore();
    }
  });
});
