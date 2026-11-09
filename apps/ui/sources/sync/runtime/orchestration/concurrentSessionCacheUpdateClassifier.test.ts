import { describe, expect, it } from 'vitest';

import {
    classifyConcurrentSessionCacheUpdate,
    shouldRefreshConcurrentSessionCacheForUpdate,
    isAccountChangeUpdate,
} from './concurrentSessionCacheUpdateClassifier';

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

    it('recognizes account updates only as push truth changes', () => {
        const accountUpdate = { body: { t: 'update-account' } };

        expect(isAccountChangeUpdate(accountUpdate)).toBe(true);
        expect(shouldRefreshConcurrentSessionCacheForUpdate(accountUpdate)).toBe(false);
        expect(isAccountChangeUpdate({ body: { t: 'update-machine' } })).toBe(false);
        expect(isAccountChangeUpdate(null)).toBe(false);
    });
    it('recognizes content-free AccountChange wakes for Follow and refreshes secondary Home lists', () => {
        const wake = { body: { t: 'account-change' } };
        expect(isAccountChangeUpdate(wake)).toBe(true);
        expect(shouldRefreshConcurrentSessionCacheForUpdate(wake)).toBe(true);
    });

    it('classifies recipient-access AccountChange wakes as Machine refreshes', () => {
        expect(classifyConcurrentSessionCacheUpdate(
            { body: { t: 'account-change' } },
            { serverId: 'home', source: 'socket', changeKinds: ['machineRecipientAccess'], entityIds: ['machine-a'] },
        )).toBe('machines');
    });
});
