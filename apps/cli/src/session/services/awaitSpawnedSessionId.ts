import {
  normalizeSpawnSessionNonceResolution,
  type SpawnSessionCreationOutcome,
  type SpawnSessionErrorDetail,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';

import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';

export type SpawnSessionNonceResolver = (
  spawnNonce: string,
  remainingTimeoutMs?: number,
) => Promise<SpawnSessionNonceResolution>;

export type AwaitSpawnedSessionIdResult =
  | { type: 'success'; sessionId: string; sessionCreationOutcome?: SpawnSessionCreationOutcome }
  | { type: 'error'; errorCode: string; errorMessage: string; agentId?: string; errorDetail?: SpawnSessionErrorDetail };

export type AbandonSpawnedSessionResult =
  | Readonly<{ status: 'completed'; sessionId: string }>
  | Readonly<{ status: 'pending' | 'not_found' | 'unsupported' | 'failed' }>;

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_ABANDON_TIMEOUT_MS = 10 * 60_000;

function readBoundedInt(raw: string | undefined, fallback: number, bounds: Readonly<{ min: number; max: number }>): number {
  const parsed = typeof raw === 'string' && raw.trim().length > 0 ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
}

function readSpawnResult(result: unknown): Readonly<{
  type: 'success';
  sessionId?: string;
  spawnNonce?: string;
  sessionCreationOutcome?: SpawnSessionCreationOutcome;
}> | Readonly<{ type: 'error'; errorCode: string; errorMessage: string; agentId?: string }> {
  if (!result || typeof result !== 'object') {
    return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Unrecognized spawn result envelope' };
  }
  const value = result as Record<string, unknown>;
  if (value.type === 'success' || value.success === true) {
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
    const spawnNonce = typeof value.spawnNonce === 'string' ? value.spawnNonce.trim() : '';
    const normalizedResolution = normalizeSpawnSessionNonceResolution({
      status: 'success',
      sessionId,
      sessionCreationOutcome: value.sessionCreationOutcome,
    });
    return {
      type: 'success',
      ...(sessionId ? { sessionId } : {}),
      ...(spawnNonce ? { spawnNonce } : {}),
      ...(normalizedResolution.status === 'success' && normalizedResolution.sessionCreationOutcome
        ? { sessionCreationOutcome: normalizedResolution.sessionCreationOutcome }
        : {}),
    };
  }
  const errorCode = typeof value.errorCode === 'string' && value.errorCode.trim().length > 0
    ? value.errorCode.trim()
    : SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED;
  const errorMessage = typeof value.errorMessage === 'string' && value.errorMessage.trim().length > 0
    ? value.errorMessage.trim()
    : typeof value.error === 'string' && value.error.trim().length > 0
      ? value.error.trim()
      : 'Failed to spawn session';
  const normalizedFailure = normalizeSpawnSessionNonceResolution({
    status: 'error', errorCode, errorMessage, agentId: value.agentId,
  });
  return { type: 'error', errorCode, errorMessage,
    ...(normalizedFailure.status === 'error' && normalizedFailure.agentId
      ? { agentId: normalizedFailure.agentId } : {}),
  };
}

export async function awaitSpawnedSessionId(params: Readonly<{
  result: unknown;
  spawnNonce: string;
  resolveSpawnSessionByNonce: SpawnSessionNonceResolver;
  timeoutMs?: number;
  signal?: AbortSignal;
}>): Promise<AwaitSpawnedSessionIdResult> {
  const result = readSpawnResult(params.result);
  if (result.type === 'error') return result;
  if (result.sessionId) {
    return {
      type: 'success',
      sessionId: result.sessionId,
      ...(result.sessionCreationOutcome
        ? { sessionCreationOutcome: result.sessionCreationOutcome }
        : {}),
    };
  }

  const timeoutMs = params.timeoutMs
    ?? readBoundedInt(process.env.HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 100, max: 10 * 60_000 });
  const settled = await new Promise<SpawnSessionNonceResolution | { status: 'timeout' }>((resolve) => {
    const finish = (result: SpawnSessionNonceResolution | { status: 'timeout' }) => {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => finish({ status: 'timeout' });
    const timer = setTimeout(abort, Math.max(0, timeoutMs));
    params.signal?.addEventListener('abort', abort, { once: true });
    if (params.signal?.aborted || timeoutMs <= 0) { abort(); return; }
    // The daemon owner parks this one observation until terminal or deadline.
    // A transport error cannot prove that the accepted spawn failed.
    void Promise.resolve().then(() => params.resolveSpawnSessionByNonce(params.spawnNonce, timeoutMs)).then(
      (resolution) => { if (resolution.status !== 'pending') finish(resolution); },
      () => {},
    );
  });
  switch (settled.status) {
    case 'success': return {
      type: 'success',
      sessionId: settled.sessionId,
      ...(settled.sessionCreationOutcome
        ? { sessionCreationOutcome: settled.sessionCreationOutcome }
        : {}),
    };
    case 'error': {
      const normalizedFailure = normalizeSpawnSessionNonceResolution(settled);
      return {
        type: 'error',
        errorCode: settled.errorCode,
        errorMessage: settled.errorMessage,
        ...(normalizedFailure.status === 'error' && normalizedFailure.agentId
          ? { agentId: normalizedFailure.agentId } : {}),
        ...(settled.errorDetail ? { errorDetail: settled.errorDetail } : {}),
      };
    }
    case 'unsupported': return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Daemon does not support spawn nonce resolution for pending spawns' };
    case 'not_found': return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'The accepted spawn is no longer tracked by the daemon' };
    case 'pending':
    case 'timeout': return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT, errorMessage: 'Timed out waiting for the spawned session id to resolve' };
  }
}

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
  if (resolution.status !== 'success') return { status: resolution.status === 'error' ? 'failed' : resolution.status };
  try {
    return await params.archiveSession(resolution.sessionId)
      ? { status: 'completed', sessionId: resolution.sessionId }
      : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

export function abandonSpawnedSessionBestEffort(params: Readonly<{
  spawnNonce: string;
  reason: string;
  resolveSpawnSessionByNonce: SpawnSessionNonceResolver;
  stopSession: (sessionId: string) => Promise<boolean>;
  archiveSession?: (sessionId: string) => Promise<void>;
}>): void {
  void (async () => {
    const timeoutMs = readBoundedInt(process.env.HAPPIER_SPAWN_ABANDON_TIMEOUT_MS, DEFAULT_ABANDON_TIMEOUT_MS, { min: 1_000, max: 60 * 60_000 });
    const settled = await awaitSpawnedSessionId({
      result: { type: 'success' },
      spawnNonce: params.spawnNonce,
      resolveSpawnSessionByNonce: params.resolveSpawnSessionByNonce,
      timeoutMs,
    });
    if (settled.type !== 'success') return;
    await params.stopSession(settled.sessionId).catch(() => false);
    await params.archiveSession?.(settled.sessionId).catch(() => undefined);
  })().catch((error) => {
    logger.debug('[awaitSpawnedSessionId] Abandon cleanup failed', {
      spawnNonce: params.spawnNonce,
      reason: params.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
