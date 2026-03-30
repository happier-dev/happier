import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session wait (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', observedAt: 123 },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['wait', 'sess-1', '--timeout', '42', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.wait.idle',
        { sessionId: 'sess-1', timeoutSeconds: 42 },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_wait',
        data: { sessionId: 'sess-1', idle: true, observedAt: 123 },
      }));
    } finally {
      output.restore();
    }
  });
});
