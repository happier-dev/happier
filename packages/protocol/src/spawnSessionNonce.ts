/**
 * Shared settlement loop for the accept-then-async spawn contract.
 *
 * A spawn request may be accepted before the spawned session's webhook lands;
 * the daemon then exposes the pending spawn through a nonce resolver
 * (`/spawn-session/resolve` / `resolveSpawnSessionByNonce`). Every consumer
 * that needs the spawned session id (fork, scripted session creation, UI spawn
 * recovery) must poll that resolver with the SAME semantics — this module is
 * the single owner of those semantics so timeouts, `not_found` handling, and
 * poll behavior cannot drift between consumers.
 */

import type { SpawnSessionErrorCode, SpawnSessionErrorDetail } from './spawnSession.js';

export type SpawnSessionNonceResolution =
  | { status: 'success'; sessionId: string }
  | {
      status: 'error';
      errorCode: SpawnSessionErrorCode;
      errorMessage: string;
      errorDetail?: SpawnSessionErrorDetail;
    }
  | { status: 'pending' }
  | { status: 'not_found' }
  | { status: 'unsupported' };

export type SettleSpawnSessionNonceResult =
  | { status: 'success'; sessionId: string }
  | {
      status: 'error';
      errorCode: SpawnSessionErrorCode;
      errorMessage: string;
      errorDetail?: SpawnSessionErrorDetail;
    }
  /** Deadline elapsed while the spawn was still tracked (slow webhook). */
  | { status: 'timeout' }
  /**
   * The nonce stayed untracked beyond the grace window: the spawn was never
   * accepted here, was pruned, or the child died before registering. Consumers
   * should fail fast instead of waiting out the full timeout.
   */
  | { status: 'not_found' }
  | { status: 'unsupported' };

const DEFAULT_NOT_FOUND_GRACE_MS = 15_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      const error = new Error('Action operation cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Action operation cancelled');
  error.name = 'AbortError';
  throw error;
}

async function waitForSleepOrAbort(sleep: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return await sleep;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const error = new Error('Action operation cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep.then(
      () => { cleanup(); resolve(); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

export async function settleSpawnSessionNonce(params: Readonly<{
  spawnNonce: string;
  resolve: (spawnNonce: string, remainingTimeoutMs?: number) => Promise<SpawnSessionNonceResolution>;
  /** `null` keeps provider-owned lifecycle settlement under its own custody. */
  timeoutMs: number | null;
  pollIntervalMs: number;
  /**
   * How long a run of consecutive `not_found` resolutions is tolerated before
   * settling as `not_found`. A `pending`/`success` resolution resets the window.
   */
  notFoundGraceMs?: number | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}>): Promise<SettleSpawnSessionNonceResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep;
  const pollIntervalMs = Math.max(1, Math.trunc(params.pollIntervalMs));
  const notFoundGraceMs = params.notFoundGraceMs === null
    ? null
    : Math.max(0, Math.trunc(params.notFoundGraceMs ?? DEFAULT_NOT_FOUND_GRACE_MS));
  const deadlineMs = params.timeoutMs === null
    ? null
    : now() + Math.max(0, Math.trunc(params.timeoutMs));

  let notFoundSinceMs: number | null = null;
  let isFirstProbe = true;

  while (true) {
    throwIfAborted(params.signal);
    const beforeProbeMs = now();
    if (!isFirstProbe && deadlineMs !== null && beforeProbeMs >= deadlineMs) {
      return { status: 'timeout' };
    }
    const remainingTimeoutMs = deadlineMs === null
      ? undefined
      : Math.max(1, deadlineMs - beforeProbeMs);
    let resolution: SpawnSessionNonceResolution;
    try {
      resolution = await params.resolve(params.spawnNonce, remainingTimeoutMs);
    } catch {
      // A transport failure says nothing about whether an accepted child
      // exists. Preserve it as pending until a caller-owned deadline or
      // positive terminal resolver evidence settles the operation.
      resolution = { status: 'pending' };
    }
    throwIfAborted(params.signal);

    if (resolution.status === 'success') {
      const sessionId = typeof resolution.sessionId === 'string' ? resolution.sessionId.trim() : '';
      if (sessionId) {
        return {
          status: 'success',
          sessionId,
        };
      }
      // A success without an id is a malformed resolver response; keep polling.
    }
    if (resolution.status === 'error') {
      return resolution;
    }
    if (resolution.status === 'unsupported') {
      return { status: 'unsupported' };
    }
    const nowMs = now();
    if (resolution.status === 'not_found') {
      notFoundSinceMs ??= nowMs;
      if (notFoundGraceMs !== null && nowMs - notFoundSinceMs >= notFoundGraceMs) {
        return { status: 'not_found' };
      }
    } else {
      notFoundSinceMs = null;
    }

    if (deadlineMs !== null && nowMs >= deadlineMs) {
      return { status: 'timeout' };
    }
    const sleepMs = deadlineMs === null
      ? pollIntervalMs
      : Math.min(pollIntervalMs, deadlineMs - nowMs);
    if (sleep) {
      await waitForSleepOrAbort(sleep(sleepMs), params.signal);
    } else {
      await defaultSleep(sleepMs, params.signal);
    }
    isFirstProbe = false;
  }
}
