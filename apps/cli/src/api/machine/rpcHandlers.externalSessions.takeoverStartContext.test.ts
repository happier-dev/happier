import { describe, expect, it, vi } from 'vitest';

import { createExternalSessionRpcActionExecutor } from './rpcHandlers.externalSessions';

describe('external-session takeover Start RPC context', () => {
  it('forwards the canonical transport cancellation signal into takeover Start', async () => {
    const start = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'internal_error' as const,
        message: 'cancelled',
      },
    }));
    const executor = createExternalSessionRpcActionExecutor(
      {} as never,
      null,
      null,
      { start },
      null,
      null,
      null,
      null,
    );
    const controller = new AbortController();
    const input = { request: { idempotencyKey: 'takeover-1' } };

    await expect(executor.execute(
      'sessions.external.takeover.start',
      input,
      { surface: 'rpc', signal: controller.signal },
    )).resolves.toEqual({
      ok: true,
      result: {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'cancelled',
        },
      },
    });
    expect(start).toHaveBeenCalledWith(input, {
      signal: controller.signal,
    });
  });
});
