import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const MANAGED_STASH_RETRY_BASE_INTERVAL_MS = 1_000;
const MANAGED_STASH_RETRY_STEP_INTERVAL_MS = 1_000;
const MANAGED_STASH_RETRY_MAX_INTERVAL_FLOOR_MS = 1_000;
const MANAGED_STASH_RETRY_MAX_INTERVAL_CEILING_MS = 10_000;
const DEFAULT_SCM_REFRESH_INTERVAL_MS = 60_000;

export function isManagedStashTransientErrorCode(errorCode: string | null | undefined): boolean {
    return errorCode === SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE;
}

export function resolveManagedStashRetryMaxIntervalMs(value: number | null | undefined): number {
    const raw = typeof value === 'number' && Number.isFinite(value)
        ? value
        : DEFAULT_SCM_REFRESH_INTERVAL_MS;
    return Math.max(
        MANAGED_STASH_RETRY_MAX_INTERVAL_FLOOR_MS,
        Math.min(MANAGED_STASH_RETRY_MAX_INTERVAL_CEILING_MS, raw),
    );
}

export function resolveManagedStashRetryDelayMs(attempt: number, maxIntervalMs: number): number {
    const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
    const nextDelay = MANAGED_STASH_RETRY_BASE_INTERVAL_MS + (safeAttempt * MANAGED_STASH_RETRY_STEP_INTERVAL_MS);
    return Math.max(
        MANAGED_STASH_RETRY_MAX_INTERVAL_FLOOR_MS,
        Math.min(Math.max(MANAGED_STASH_RETRY_MAX_INTERVAL_FLOOR_MS, maxIntervalMs), nextDelay),
    );
}

export function shouldContinueManagedStashRetry(params: Readonly<{
    startedAtMs: number;
    nextDelayMs: number;
    maxIntervalMs: number;
    nowMs?: number;
}>): boolean {
    const nowMs = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
    const elapsedMs = Math.max(0, nowMs - params.startedAtMs);
    return elapsedMs + params.nextDelayMs <= params.maxIntervalMs;
}
