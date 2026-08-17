/** Canonical settlement policy for accept-then-async session spawning. */

import {
  SessionOrganizationPlacementV1Schema,
  type SessionOrganizationPlacementV1,
} from './creation/sessionSpawnNewResultV1.js';
import {
  SpawnSessionErrorCodeSchema,
  isSpawnSessionErrorDetail,
  type SpawnSessionErrorCode,
  type SpawnSessionErrorDetail,
} from './spawnSession.js';

export type SpawnSessionCreationOutcome = Readonly<{
  disposition: 'created' | 'rejoined';
  organizationPlacement: SessionOrganizationPlacementV1;
}>;

export type SpawnSessionNonceResolution =
  | { status: 'success'; sessionId: string; sessionCreationOutcome?: SpawnSessionCreationOutcome }
  | { status: 'error'; errorCode: SpawnSessionErrorCode; errorMessage: string; errorDetail?: SpawnSessionErrorDetail }
  | { status: 'pending' }
  | { status: 'not_found' }
  | { status: 'unsupported' };

export type SettleSpawnSessionNonceResult =
  | { status: 'success'; sessionId: string; sessionCreationOutcome?: SpawnSessionCreationOutcome }
  | { status: 'error'; errorCode: SpawnSessionErrorCode; errorMessage: string; errorDetail?: SpawnSessionErrorDetail }
  | { status: 'timeout' }
  | { status: 'not_found' }
  | { status: 'unsupported' };

const DEFAULT_NOT_FOUND_GRACE_MS = 15_000;

function parseSpawnSessionCreationOutcome(value: unknown): SpawnSessionCreationOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const outcome = value as Readonly<Record<string, unknown>>;
  const disposition = outcome.disposition;
  if (disposition !== 'created' && disposition !== 'rejoined') return null;
  const placement = SessionOrganizationPlacementV1Schema.safeParse(outcome.organizationPlacement);
  return placement.success
    ? { disposition, organizationPlacement: placement.data }
    : null;
}

/** Canonical boundary reader shared by local and machine-RPC nonce settlement. */
export function normalizeSpawnSessionNonceResolution(value: unknown): SpawnSessionNonceResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'not_found' };
  const record = value as Readonly<Record<string, unknown>>;
  const status = typeof record.status === 'string' ? record.status.trim() : '';
  if (status === 'pending' || status === 'not_found' || status === 'unsupported') {
    return { status };
  }
  if (status === 'error') {
    const errorCode = SpawnSessionErrorCodeSchema.safeParse(record.errorCode);
    const errorMessage = typeof record.errorMessage === 'string' ? record.errorMessage.trim() : '';
    if (!errorCode.success || !errorMessage) return { status: 'not_found' };
    return {
      status: 'error',
      errorCode: errorCode.data,
      errorMessage,
      ...(isSpawnSessionErrorDetail(record.errorDetail) ? { errorDetail: record.errorDetail } : {}),
    };
  }
  if (status === 'success') {
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    if (!sessionId) return { status: 'not_found' };
    const parsedOutcome = parseSpawnSessionCreationOutcome(record.sessionCreationOutcome);
    return {
      status: 'success',
      sessionId,
      ...(parsedOutcome ? { sessionCreationOutcome: parsedOutcome } : {}),
    };
  }
  return { status: 'not_found' };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ABORTED = Symbol('spawn-session-nonce-settlement-aborted');

/**
 * Keep the accepted-spawn settlement owned here even when its caller stops
 * waiting. The underlying resolver/sleeper remains observed so a late
 * rejection cannot escape, while the caller gets a prompt unresolved result.
 */
function awaitOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      resolve(ABORTED);
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function settleSpawnSessionNonce(params: Readonly<{
  spawnNonce: string;
  resolve: (spawnNonce: string, remainingTimeoutMs: number) => Promise<SpawnSessionNonceResolution>;
  timeoutMs: number;
  pollIntervalMs: number;
  notFoundGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}>): Promise<SettleSpawnSessionNonceResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? defaultSleep;
  const pollIntervalMs = Math.max(1, Math.trunc(params.pollIntervalMs));
  const notFoundGraceMs = Math.max(0, Math.trunc(params.notFoundGraceMs ?? DEFAULT_NOT_FOUND_GRACE_MS));
  const deadlineMs = now() + Math.max(0, Math.trunc(params.timeoutMs));
  let notFoundSinceMs: number | null = null;
  let isFirstProbe = true;

  while (true) {
    if (params.signal?.aborted) return { status: 'timeout' };
    const beforeProbeMs = now();
    if (!isFirstProbe && beforeProbeMs >= deadlineMs) return { status: 'timeout' };
    const remainingTimeoutMs = Math.max(1, deadlineMs - beforeProbeMs);
    let resolution: SpawnSessionNonceResolution;
    try {
      const resolved = await awaitOrAbort(
        params.resolve(params.spawnNonce, remainingTimeoutMs),
        params.signal,
      );
      if (resolved === ABORTED) return { status: 'timeout' };
      resolution = resolved;
    } catch {
      // A resolver transport failure says nothing about whether an accepted
      // spawn exists. Keep it recoverable until the canonical deadline.
      if (params.signal?.aborted) return { status: 'timeout' };
      resolution = { status: 'pending' };
    }

    if (resolution.status === 'success') {
      const sessionId = typeof resolution.sessionId === 'string' ? resolution.sessionId.trim() : '';
      if (sessionId) {
        return {
          status: 'success',
          sessionId,
          ...(resolution.sessionCreationOutcome
            ? { sessionCreationOutcome: resolution.sessionCreationOutcome }
            : {}),
        };
      }
    }
    if (resolution.status === 'error') return resolution;
    if (resolution.status === 'unsupported') return { status: 'unsupported' };

    const nowMs = now();
    if (resolution.status === 'not_found') {
      notFoundSinceMs ??= nowMs;
      if (nowMs - notFoundSinceMs >= notFoundGraceMs) return { status: 'not_found' };
    } else {
      notFoundSinceMs = null;
    }
    if (nowMs >= deadlineMs) return { status: 'timeout' };
    if (await awaitOrAbort(sleep(Math.min(pollIntervalMs, deadlineMs - nowMs)), params.signal) === ABORTED) {
      return { status: 'timeout' };
    }
    isFirstProbe = false;
  }
}
