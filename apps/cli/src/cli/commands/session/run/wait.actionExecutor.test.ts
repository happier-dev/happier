import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));
const resolveSessionTransportContext = vi.fn(async () => ({ ok: true, sessionId: 'sess-canonical' }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({ resolveSessionTransportContext }));

describe('happier session run wait (action executor)', () => {
  beforeEach(() => {
    execute.mockReset();
    createCliActionExecutorFromCredentials.mockClear();
    resolveSessionTransportContext.mockClear();
  });

  it('does not add a default timeout when --timeout is omitted', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, status: 'succeeded', result: {} },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'wait', 'sess-1', 'run-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledWith(
        'execution.run.wait',
        { sessionId: 'sess-canonical', runId: 'run-1' },
        { surface: 'cli', defaultSessionId: null },
      );
    } finally {
      output.restore();
    }
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, status: 'succeeded', result: {} },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'wait', 'sess-1', 'run-1', '--timeout', '42', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'execution.run.wait',
        { sessionId: 'sess-canonical', runId: 'run-1', timeoutSeconds: 42 },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_wait',
        data: { sessionId: 'sess-canonical', runId: 'run-1', status: 'succeeded' },
      }));
    } finally {
      output.restore();
    }
  });

  it('rejects an explicit invalid timeout before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionRunWait } = await import('./wait');

    await expect(cmdSessionRunWait(
      ['session', 'run', 'sess-prefix', 'run-1', '--timeout', '0'],
      { readCredentialsFn },
    )).rejects.toMatchObject({ code: 'invalid_arguments' });

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
  });
});
