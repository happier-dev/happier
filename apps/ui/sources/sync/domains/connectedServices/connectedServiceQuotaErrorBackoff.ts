/**
 * The ONE retry policy for connected-service quota/usage polling.
 *
 * Every quota poller (legacy snapshot store, provider account usage snapshots,
 * qualified V4 snapshot store) backs off through this owner so a persistently
 * failing account cannot be hammered at a flat interval forever, and so the
 * three surfaces cannot drift to different ladders.
 */
export const CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MIN_MS = 30_000;
export const CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Exponential backoff clamped to [min, max]. `consecutiveErrors <= 1` yields the
 * minimum delay, then each further consecutive failure doubles it.
 */
export function computeConnectedServiceQuotaErrorBackoffMs(consecutiveErrors: number): number {
    const exp = CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MIN_MS
        * Math.pow(2, Math.max(0, consecutiveErrors - 1));
    return Math.max(
        CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MIN_MS,
        Math.min(CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MAX_MS, Math.trunc(exp)),
    );
}
