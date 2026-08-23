import {
  isSpawnSessionErrorDetail,
  settleSpawnSessionNonce,
  type SpawnSessionErrorDetail,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';

import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionErrorCode } from '@/rpc/handlers/registerSessionHandlers';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';

/**
 * Daemon spawn is accept-then-async: a spawn request may return
 * `{ type: 'success', sessionIdStatus: 'pending', spawnNonce }` before the
 * session webhook lands. Callers that need the spawned session id (fork,
 * scripted flows) must resolve it through the daemon's nonce-resolution
 * contract instead of treating the pending acceptance as a failure.
 *
 * The polling semantics live in the shared protocol primitive
 * `settleSpawnSessionNonce`; this module adapts them to the CLI's
 * `SpawnSessionResult` envelope.
 */
export type SpawnSessionNonceResolver = (
  spawnNonce: string,
  remainingTimeoutMs?: number,
) => Promise<SpawnSessionNonceResolution>;

export type AwaitSpawnedSessionIdResult =
  | { type: 'success'; sessionId: string }
  | { type: 'error'; errorCode: string; errorMessage: string; errorDetail?: SpawnSessionErrorDetail };

export type AbandonSpawnedSessionResult =
  | Readonly<{ status: 'completed'; sessionId: string }>
  | Readonly<{ status: 'pending' | 'not_found' | 'unsupported' | 'failed' }>;

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_ABANDON_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ABANDON_POLL_INTERVAL_MS = 2_000;

function resolveBoundedIntEnv(raw: string | undefined, fallback: number, bounds: Readonly<{ min: number; max: number }>): number {
  const parsed = typeof raw === 'string' && raw.trim().length > 0 ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
}

/**
 * Normalize a raw daemon spawn envelope (`{success, sessionId?, spawnNonce?, ...}`)
 * into the typed `SpawnSessionResult` union. Returns null when the value is not a
 * raw envelope (already typed, or unrecognized). Single owner — the machine RPC
 * layer and the pending-spawn helpers must share the exact same interpretation.
 */
export function normalizeDaemonSpawnSessionEnvelope(result: unknown): SpawnSessionResult | null {
  if (!result || typeof result !== 'object') return null;
  const envelope = result as Record<string, unknown>;
  if (typeof envelope.type === 'string') return null;

  if (envelope.success === true) {
    const sessionId = typeof envelope.sessionId === 'string' ? envelope.sessionId.trim() : '';
    const spawnNonce = typeof envelope.spawnNonce === 'string' ? envelope.spawnNonce.trim() : '';
    const sessionIdStatus =
      envelope.sessionIdStatus === 'pending' || envelope.sessionIdStatus === 'available'
        ? envelope.sessionIdStatus
        : envelope.status === 'pending'
          ? 'pending'
          : undefined;
    if (!sessionId && !spawnNonce && !sessionIdStatus) return null;
    return {
      type: 'success',
      ...(sessionId ? { sessionId } : {}),
      ...(spawnNonce ? { spawnNonce } : {}),
      ...(sessionIdStatus ? { sessionIdStatus } : {}),
    };
  }

  if (envelope.success !== false) return null;

  if (
    envelope.requiresUserApproval === true
    && envelope.actionRequired === 'CREATE_DIRECTORY'
    && typeof envelope.directory === 'string'
  ) {
    return { type: 'requestToApproveDirectoryCreation', directory: envelope.directory };
  }

  const rawErrorCode = typeof envelope.errorCode === 'string' && envelope.errorCode.trim().length > 0
    ? envelope.errorCode.trim()
    : SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED;
  const errorCode = (Object.values(SPAWN_SESSION_ERROR_CODES) as string[]).includes(rawErrorCode)
    ? rawErrorCode as SpawnSessionErrorCode
    : SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED;
  const errorMessage = typeof envelope.error === 'string' && envelope.error.trim().length > 0
    ? envelope.error.trim()
    : typeof envelope.message === 'string' && envelope.message.trim().length > 0
      ? envelope.message.trim()
      : envelope.status === 'pending' && errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
        ? 'Session startup is still pending'
        : 'Failed to spawn session';
  const errorDetail = isSpawnSessionErrorDetail(envelope.errorDetail) ? envelope.errorDetail : undefined;

  return {
    type: 'error',
    errorCode,
    errorMessage,
    ...(errorDetail ? { errorDetail } : {}),
  };
}

export async function awaitSpawnedSessionId(params: Readonly<{
  result: SpawnSessionResult | unknown;
  resolveSpawnSessionByNonce?: SpawnSessionNonceResolver;
  /** `null` is reserved for provider-native fork lifecycle settlement. */
  timeoutMs?: number | null;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}>): Promise<AwaitSpawnedSessionIdResult> {
  const normalized = normalizeDaemonSpawnSessionEnvelope(params.result);
  const result = (normalized ?? params.result) as SpawnSessionResult;

  if (!result || typeof result !== 'object' || typeof (result as { type?: unknown }).type !== 'string') {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'Unrecognized spawn result envelope',
    };
  }
  if (result.type === 'error') {
    return {
      type: 'error',
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
    };
  }
  if (result.type === 'requestToApproveDirectoryCreation') {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: `Directory creation approval required for ${result.directory}`,
    };
  }

  const directSessionId = typeof result.sessionId === 'string' ? result.sessionId.trim() : '';
  if (directSessionId) {
    return { type: 'success', sessionId: directSessionId };
  }

  const spawnNonce = typeof result.spawnNonce === 'string' ? result.spawnNonce.trim() : '';
  const resolver = params.resolveSpawnSessionByNonce;
  if (!spawnNonce || !resolver) {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'Spawn was accepted without a session id and nonce resolution is unavailable',
    };
  }

  const timeoutMs = params.timeoutMs === null
    ? null
    : params.timeoutMs
      ?? resolveBoundedIntEnv(process.env.HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 100, max: 10 * 60_000 });
  const pollIntervalMs = params.pollIntervalMs
    ?? resolveBoundedIntEnv(process.env.HAPPIER_SPAWN_SESSION_ID_RESOLVE_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, { min: 25, max: 10_000 });
  const notFoundGraceMs = timeoutMs === null
    ? null
    : resolveBoundedIntEnv(
      process.env.HAPPIER_SPAWN_SESSION_ID_RESOLVE_NOT_FOUND_GRACE_MS,
      Math.min(timeoutMs, 15_000),
      { min: 100, max: 10 * 60_000 },
    );

  const settled = await settleSpawnSessionNonce({
    spawnNonce,
    resolve: resolver,
    timeoutMs,
    pollIntervalMs,
    notFoundGraceMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  switch (settled.status) {
    case 'success':
      return { type: 'success', sessionId: settled.sessionId };
    case 'error':
      return {
        type: 'error',
        errorCode: settled.errorCode,
        errorMessage: settled.errorMessage,
        ...(settled.errorDetail ? { errorDetail: settled.errorDetail } : {}),
      };
    case 'unsupported':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Daemon does not support spawn nonce resolution for pending spawns',
      };
    case 'not_found':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: 'The accepted spawn is no longer tracked by the daemon (child likely exited before registering)',
      };
    case 'timeout':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Timed out waiting for the spawned session id to resolve',
      };
  }
}

/**
 * Synchronous, proof-carrying abandon path for UI custody transfer. It reports
 * completed only after the nonce resolves and the canonical stop/archive owner
 * positively confirms the session is archived. Every ambiguous or failed path
 * remains non-completed so callers must retain custody.
 */
export async function abandonSpawnedSessionUntilCompleted(params: Readonly<{
  spawnNonce: string;
  resolveSpawnSessionByNonce: SpawnSessionNonceResolver;
  archiveSession: (sessionId: string) => Promise<boolean>;
}>): Promise<AbandonSpawnedSessionResult> {
  const spawnNonce = params.spawnNonce.trim();
  if (!spawnNonce) return { status: 'not_found' };

  let resolution: SpawnSessionNonceResolution;
  try {
    resolution = await params.resolveSpawnSessionByNonce(spawnNonce);
  } catch {
    return { status: 'failed' };
  }
  if (resolution.status !== 'success') {
    return { status: resolution.status === 'error' ? 'failed' : resolution.status };
  }

  try {
    return await params.archiveSession(resolution.sessionId)
      ? { status: 'completed', sessionId: resolution.sessionId }
      : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

/**
 * Best-effort compensation for an ACCEPTED spawn whose caller gave up waiting:
 * keep resolving the nonce in the background and, when the child finally
 * registers, stop and archive it so it does not linger as an orphan session.
 *
 * Fire-and-forget: failures are logged, never thrown. If the daemon restarts
 * before the child registers, the orphan survives — that residual window is
 * accepted and observable through the log line emitted here.
 */
export function abandonSpawnedSessionBestEffort(params: Readonly<{
  spawnNonce: string;
  reason: string;
  resolveSpawnSessionByNonce: SpawnSessionNonceResolver;
  stopSession: (sessionId: string) => Promise<boolean>;
  archiveSession?: (sessionId: string) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}>): void {
  const timeoutMs = params.timeoutMs
    ?? resolveBoundedIntEnv(process.env.HAPPIER_SPAWN_ABANDON_TIMEOUT_MS, DEFAULT_ABANDON_TIMEOUT_MS, { min: 1_000, max: 60 * 60_000 });
  const pollIntervalMs = params.pollIntervalMs
    ?? resolveBoundedIntEnv(process.env.HAPPIER_SPAWN_ABANDON_POLL_INTERVAL_MS, DEFAULT_ABANDON_POLL_INTERVAL_MS, { min: 100, max: 60_000 });

  logger.debug('[awaitSpawnedSessionId] Abandoning accepted spawn; will clean up the child when it registers', {
    spawnNonce: params.spawnNonce,
    reason: params.reason,
    timeoutMs,
  });

  void (async () => {
    const settled = await settleSpawnSessionNonce({
      spawnNonce: params.spawnNonce,
      resolve: params.resolveSpawnSessionByNonce,
      timeoutMs,
      pollIntervalMs,
      // The abandoned spawn may take a while to (re)appear; tolerate long
      // not_found runs and only give up at the overall deadline.
      notFoundGraceMs: timeoutMs,
      sleep: delay,
    });
    if (settled.status !== 'success') {
      logger.debug('[awaitSpawnedSessionId] Abandoned spawn never resolved to a session id', {
        spawnNonce: params.spawnNonce,
        status: settled.status,
      });
      return;
    }
    logger.debug('[awaitSpawnedSessionId] Cleaning up abandoned spawn child session', {
      spawnNonce: params.spawnNonce,
      sessionId: settled.sessionId,
    });
    await params.stopSession(settled.sessionId).catch(() => false);
    if (params.archiveSession) {
      await params.archiveSession(settled.sessionId).catch(() => undefined);
    }
  })().catch((error) => {
    logger.debug('[awaitSpawnedSessionId] Abandon cleanup failed', {
      spawnNonce: params.spawnNonce,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
