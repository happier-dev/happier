import { describe, expect, it, vi } from 'vitest';

describe('executeSessionForkAction', () => {
  it('returns the child session id when the action executor returns a successful fork result', async () => {
    const { executeSessionForkAction } = await import('./executeSessionForkAction');

    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        ok: true,
        status: 'forked',
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
      },
    }));

    const result = await executeSessionForkAction({
      execute: execute as any,
      sessionId: 'parent-1',
      context: { defaultSessionId: 'parent-1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(result).toEqual({ ok: true, childSessionId: 'child-1' });
  });

  it('returns an error when the action executor fails before producing a fork result', async () => {
    const { executeSessionForkAction } = await import('./executeSessionForkAction');

    const execute = vi.fn(async () => ({
      ok: false,
      errorCode: 'boom',
      error: 'boom',
    }));

    const result = await executeSessionForkAction({
      execute: execute as any,
      sessionId: 'parent-1',
      context: { defaultSessionId: 'parent-1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(result).toEqual({ ok: false, error: 'boom' });
  });

  it('returns an error when the nested fork result is not successful', async () => {
    const { executeSessionForkAction } = await import('./executeSessionForkAction');

    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        ok: false,
        errorCode: 'fork_failed',
        errorMessage: 'fork_failed',
      },
    }));

    const result = await executeSessionForkAction({
      execute: execute as any,
      sessionId: 'parent-1',
      context: { defaultSessionId: 'parent-1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(result).toEqual({ ok: false, error: 'fork_failed' });
  });
});
