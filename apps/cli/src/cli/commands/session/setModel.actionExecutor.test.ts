import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session set-model (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', modelId: 'gpt-4o', updatedAt: 123 },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['set-model', 'sess-1', 'gpt-4o', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.model.set',
        { sessionId: 'sess-1', modelId: 'gpt-4o' },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_set_model',
        data: { sessionId: 'sess-1', modelId: 'gpt-4o', updatedAt: 123 },
      }));
    } finally {
      output.restore();
    }
  });
});
