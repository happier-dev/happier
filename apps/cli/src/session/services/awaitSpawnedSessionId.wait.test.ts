import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitSpawnedSessionId } from './awaitSpawnedSessionId';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

describe('awaitSpawnedSessionId terminal observation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('lets the daemon startup budget govern default pending spawn observation', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS', undefined);
    vi.stubEnv('HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS', undefined);
    let resolveStartup!: (result: { status: 'success'; sessionId: string }) => void;
    const startup = new Promise<{ status: 'success'; sessionId: string }>((resolve) => { resolveStartup = resolve; });
    let settled = false;
    const wait = awaitSpawnedSessionId({
      result: { type: 'success' }, spawnNonce: 'slow-startup',
      resolveSpawnSessionByNonce: () => startup,
    }).then((result) => { settled = true; return result; });

    await vi.advanceTimersByTimeAsync(90_001);
    expect(settled).toBe(false);
    resolveStartup({ status: 'success', sessionId: 'ready-session' });
    await expect(wait).resolves.toEqual({ type: 'success', sessionId: 'ready-session' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the daemon startup override when no caller observation budget was authored', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS', undefined);
    vi.stubEnv('HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS', '180000');
    const resolve = vi.fn(async () => ({ status: 'pending' as const }));
    const wait = awaitSpawnedSessionId({
      result: { type: 'success' }, spawnNonce: 'startup-override', resolveSpawnSessionByNonce: resolve,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolve).toHaveBeenCalledWith('startup-override', 180_000, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(wait).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
  });

  it('honors an authored observation duration beyond the old phase-local cap', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS', '1200000');
    const resolve = vi.fn(async () => ({ status: 'pending' as const }));
    let settled = false;
    const wait = awaitSpawnedSessionId({
      result: { type: 'success' }, spawnNonce: 'long-observation', resolveSpawnSessionByNonce: resolve,
    }).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(600_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(599_999);
    await expect(wait).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(resolve).toHaveBeenCalledWith('long-observation', 1_200_000, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a long caller deadline across the Node timer boundary and cancellation', async () => {
    vi.useFakeTimers();
    const timeoutMs = 30 * 24 * 60 * 60 * 1_000;
    const resolve = vi.fn(async () => ({ status: 'pending' as const }));
    let settled = false;
    const wait = awaitSpawnedSessionId({
      result: { type: 'success' }, spawnNonce: 'long-caller', resolveSpawnSessionByNonce: resolve, timeoutMs,
    }).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(timeoutMs - 2_147_483_647);
    await expect(wait).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });

    const controller = new AbortController();
    const cancelled = awaitSpawnedSessionId({
      result: { type: 'success' }, spawnNonce: 'cancel-long', resolveSpawnSessionByNonce: resolve,
      timeoutMs, signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains daemon-proven Agent identity from a terminal nonce failure', async () => {
    // The daemon nonce transport is the genuine boundary; settlement stays real.
    await expect(awaitSpawnedSessionId({
      result: { type: 'success' },
      spawnNonce: 'agent-setup-nonce',
      resolveSpawnSessionByNonce: async () => ({
        status: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT,
        errorMessage: 'Agent setup required', agentId: 'codex',
      }),
    })).resolves.toEqual({
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT,
      errorMessage: 'Agent setup required', agentId: 'codex',
    });

    const immediateFailure = {
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT,
      errorMessage: 'Agent setup required', agentId: 'codex',
    };
    await expect(awaitSpawnedSessionId({
      result: immediateFailure, spawnNonce: 'agent-setup-nonce',
      resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
    })).resolves.toEqual(immediateFailure);
    for (const agentId of [undefined, '']) {
      await expect(awaitSpawnedSessionId({
        result: { ...immediateFailure, agentId }, spawnNonce: 'agent-setup-nonce',
        resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
      })).resolves.toEqual({
        type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT,
        errorMessage: 'Agent setup required',
      });
    }
    await expect(awaitSpawnedSessionId({
      result: { ...immediateFailure, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED },
      spawnNonce: 'agent-setup-nonce',
      resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
    })).resolves.toEqual({
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'Agent setup required',
    });
  });

  it('keeps transport loss unresolved until the containing deadline without redispatch', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => { throw new Error('control transport lost'); });
    let settled = false;
    const wait = awaitSpawnedSessionId({ result: { type: 'success' }, spawnNonce: 'nonce', resolveSpawnSessionByNonce: resolve, timeoutMs: 1_000 })
      .then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    expect(resolve).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(await wait).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
  });

  it('makes one deadline-bounded observation without a cadence when the owner returns pending', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => ({ status: 'pending' as const }));
    const wait = awaitSpawnedSessionId({ result: { type: 'success' }, spawnNonce: 'nonce', resolveSpawnSessionByNonce: resolve, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(500);
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await wait).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
  });

  it('bounds a stuck transport and cancellation by the containing wait', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(() => new Promise<never>(() => {}));
    const signal = new AbortController();
    const wait = awaitSpawnedSessionId({ result: { type: 'success' }, spawnNonce: 'nonce', resolveSpawnSessionByNonce: resolve, timeoutMs: 1_000, signal: signal.signal });
    signal.abort();
    expect(await wait).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(vi.getTimerCount()).toBe(0);
    const timed = awaitSpawnedSessionId({ result: { type: 'success' }, spawnNonce: 'nonce', resolveSpawnSessionByNonce: resolve, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await timed).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deadline', 'cancel'] as const)('retires the transport observation when its containing %s ends', async (ending) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    let readRemainingTimeoutMs: (() => number) | undefined;
    const wait = awaitSpawnedSessionId({
      result: { type: 'success' }, spawnNonce: 'original-nonce', timeoutMs: 1_000, signal: controller.signal,
      resolveSpawnSessionByNonce: (_nonce, _timeoutMs, observation?: Readonly<{
        signal: AbortSignal; readRemainingTimeoutMs: () => number;
      }>) => {
        transportSignal = observation?.signal;
        readRemainingTimeoutMs = observation?.readRemainingTimeoutMs;
        return new Promise<never>(() => {});
      },
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(readRemainingTimeoutMs?.()).toBe(750);
    if (ending === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(750);
    await expect(wait).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(transportSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
