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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function settleSpawnSessionNonce(params: Readonly<{
  spawnNonce: string;
  resolve: (spawnNonce: string) => Promise<SpawnSessionNonceResolution>;
  timeoutMs: number;
  pollIntervalMs: number;
  /**
   * How long a run of consecutive `not_found` resolutions is tolerated before
   * settling as `not_found`. A `pending`/`success` resolution resets the window.
   */
  notFoundGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}>): Promise<SettleSpawnSessionNonceResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? defaultSleep;
  const pollIntervalMs = Math.max(1, Math.trunc(params.pollIntervalMs));
  const notFoundGraceMs = Math.max(0, Math.trunc(params.notFoundGraceMs ?? DEFAULT_NOT_FOUND_GRACE_MS));
  const deadlineMs = now() + Math.max(0, Math.trunc(params.timeoutMs));

  let notFoundSinceMs: number | null = null;

  while (true) {
    let resolution: SpawnSessionNonceResolution;
    try {
      resolution = await params.resolve(params.spawnNonce);
    } catch {
      // Transient transport failures are indistinguishable from "not tracked";
      // treat them as a not_found probe so a dead daemon still settles via the
      // grace window instead of aborting the loop.
      resolution = { status: 'not_found' };
    }

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
      if (nowMs - notFoundSinceMs >= notFoundGraceMs) {
        return { status: 'not_found' };
      }
    } else {
      notFoundSinceMs = null;
    }

    if (nowMs >= deadlineMs) {
      return { status: 'timeout' };
    }
    await sleep(pollIntervalMs);
  }
}
