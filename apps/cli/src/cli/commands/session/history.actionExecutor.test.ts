import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session history (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', format: 'compact', messages: [] },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['history', 'sess-1', '--limit', '10', '--format', 'raw', '--include-meta', '--include-structured-payload', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.history.get',
        {
          sessionId: 'sess-1',
          limit: 10,
          format: 'raw',
          includeMeta: true,
          includeStructuredPayload: true,
        },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_history',
        data: { sessionId: 'sess-1', format: 'compact', messages: [] },
      }));
    } finally {
      output.restore();
    }
  });

  it('rejects unsupported formats as invalid arguments before reading credentials', async () => {
    execute.mockClear();
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionHistory } = await import('./history');

    await expect(cmdSessionHistory(
      ['history', 'sess-1', '--format', 'definitely-invalid'],
      { readCredentialsFn },
    )).rejects.toThrow('Invalid --format value "definitely-invalid". Expected one of: compact, raw.');

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
