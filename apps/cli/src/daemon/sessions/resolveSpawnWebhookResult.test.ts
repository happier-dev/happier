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

  it('keeps attach webhook-timeout errors even when the tracked session already has a canonical session id', () => {
    const trackedSession = {
      startedBy: 'daemon',
      pid: 321,
      happySessionId: 'session-321',
      spawnOptions: {
        existingSessionId: 'session-321',
      },
    } as TrackedSession;
    const pidToTrackedSession = new Map<number, TrackedSession>([[321, trackedSession]]);
    const warn = vi.fn();
    const result: SpawnSessionResult = {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'timed out',
    };

    const resolved = resolveSpawnWebhookResult({
      pid: 321,
      result,
      pidToTrackedSession,
      warn,
    });

    expect(resolved).toEqual(result);
    expect(pidToTrackedSession.get(321)?.happySessionId).toBe('session-321');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('session-321');
  });

  it('keeps webhook-timeout errors when canonical startup readiness missed its deadline', () => {
    const trackedSession = {
      startedBy: 'daemon',
      pid: 322,
      happySessionId: 'session-322',
      sessionWebhookTimedOutAtMs: 1_717_171_717_000,
    } as TrackedSession;
    const pidToTrackedSession = new Map<number, TrackedSession>([[322, trackedSession]]);
    const warn = vi.fn();

    const resolved = resolveSpawnWebhookResult({
      pid: 322,
      result: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'timed out',
      },
      pidToTrackedSession,
      warn,
    });

    expect(resolved).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'timed out',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('session-322');
  });

  it('does not log a canonical session id when recovering a webhook timeout', () => {
    const trackedSession = {
      startedBy: 'daemon',
      pid: 323,
      happySessionId: 'private-session-323',
    } as TrackedSession;
    const pidToTrackedSession = new Map<number, TrackedSession>([[323, trackedSession]]);
    const warn = vi.fn();

    const resolved = resolveSpawnWebhookResult({
      pid: 323,
      result: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'timed out',
      },
      pidToTrackedSession,
      warn,
    });

    expect(resolved).toEqual({ type: 'success', sessionId: 'private-session-323' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-session-323');
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
