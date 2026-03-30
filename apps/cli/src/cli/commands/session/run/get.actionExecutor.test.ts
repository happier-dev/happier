import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session run get (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, run: { runId: 'run-1' } },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'get', 'sess-1', 'run-1', '--include-structured', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'execution.run.get',
        { sessionId: 'sess-1', runId: 'run-1', includeStructured: true },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_get',
      }));
    } finally {
      output.restore();
    }
  });
});
