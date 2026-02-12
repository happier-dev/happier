import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '@/daemon/types';
import { resolveSpawnWebhookResult } from './resolveSpawnWebhookResult';

describe('resolveSpawnWebhookResult', () => {
  it('returns success results unchanged', () => {
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const warn = vi.fn();
    const result: SpawnSessionResult = { type: 'success', sessionId: 'session-1' };

    const resolved = resolveSpawnWebhookResult({
      pid: 123,
      result,
      pidToTrackedSession,
      warn,
    });

    expect(resolved).toEqual(result);
    expect(warn).not.toHaveBeenCalled();
  });

  it('converts webhook-timeout errors to success when tracked session already has a canonical session id', () => {
    const trackedSession = {
      startedBy: 'daemon',
      pid: 321,
      happySessionId: 'session-321',
    } as TrackedSession;
    const pidToTrackedSession = new Map<number, TrackedSession>([[321, trackedSession]]);
    const warn = vi.fn();

    const resolved = resolveSpawnWebhookResult({
      pid: 321,
      result: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'timed out',
      },
      pidToTrackedSession,
      warn,
    });

    expect(resolved).toEqual({ type: 'success', sessionId: 'session-321' });
    expect(pidToTrackedSession.get(321)?.happySessionId).toBe('session-321');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps webhook-timeout error when tracked session has no canonical session id yet', () => {
    const trackedSession = {
      startedBy: 'daemon',
      pid: 404,
      happySessionId: 'PID-404',
    } as TrackedSession;
    const pidToTrackedSession = new Map<number, TrackedSession>([[404, trackedSession]]);
    const warn = vi.fn();
    const result: SpawnSessionResult = {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'timed out',
    };

    const resolved = resolveSpawnWebhookResult({
      pid: 404,
      result,
      pidToTrackedSession,
      warn,
    });

    expect(resolved).toEqual(result);
    expect(pidToTrackedSession.get(404)?.happySessionId).toBe('PID-404');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps webhook-timeout error when PID is not tracked', () => {
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const warn = vi.fn();
    const result: SpawnSessionResult = {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'timed out',
    };

    const resolved = resolveSpawnWebhookResult({
      pid: 404,
      result,
      pidToTrackedSession,
      warn,
    });

    expect(resolved).toEqual(result);
    expect(warn).not.toHaveBeenCalled();
  });
});
