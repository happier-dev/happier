const CONCURRENT_SESSION_CACHE_REFRESH_UPDATE_TYPES = new Set([
    'new-machine',
    'update-machine',
    'new-session',
    'delete-session',
    'pending-changed',
    'update-session',
    'new-message',
    'message-updated',
]);

export function shouldRefreshConcurrentSessionCacheForUpdate(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') {
        return false;
    }

    const body = (raw as { body?: unknown }).body;
    if (!body || typeof body !== 'object') {
        return false;
    }

    const updateType = (body as { t?: unknown }).t;
    return typeof updateType === 'string' && CONCURRENT_SESSION_CACHE_REFRESH_UPDATE_TYPES.has(updateType);
}
