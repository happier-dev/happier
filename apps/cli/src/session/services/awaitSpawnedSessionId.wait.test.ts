import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitSpawnedSessionId } from './awaitSpawnedSessionId';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

describe('awaitSpawnedSessionId terminal observation', () => {
  afterEach(() => vi.useRealTimers());

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
});
