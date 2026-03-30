import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session run action (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, output: {} },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'action', 'sess-1', 'run-1', 'action-1', '--input-json', '{"a":1}', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'execution.run.action',
        { sessionId: 'sess-1', runId: 'run-1', actionId: 'action-1', input: { a: 1 } },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_action',
      }));
    } finally {
      output.restore();
    }
  });
});
