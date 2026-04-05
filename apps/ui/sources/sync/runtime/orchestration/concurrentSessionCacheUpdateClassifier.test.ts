import { describe, expect, it } from 'vitest';

import { shouldRefreshConcurrentSessionCacheForUpdate } from './concurrentSessionCacheUpdateClassifier';

describe('shouldRefreshConcurrentSessionCacheForUpdate', () => {
    it('returns true for machine and session-list-affecting updates', () => {
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'new-machine' } })).toBe(true);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'update-machine' } })).toBe(true);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'new-session' } })).toBe(true);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'delete-session' } })).toBe(true);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'pending-changed' } })).toBe(true);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'update-session' } })).toBe(true);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'new-message' } })).toBe(true);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'message-updated' } })).toBe(true);
    });

    it('returns false for unrelated or malformed updates', () => {
        expect(shouldRefreshConcurrentSessionCacheForUpdate(null)).toBe(false);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({})).toBe(false);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: null })).toBe(false);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'update-account' } })).toBe(false);
        expect(shouldRefreshConcurrentSessionCacheForUpdate({ body: { t: 'todo-kv-batch' } })).toBe(false);
    });
});
