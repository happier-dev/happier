import { readStoredSessionMessagesFromStateLike } from '@/sync/domains/messages/readStoredSessionMessages';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

import { deriveLatestPendingRequestObservedAtFromSession } from './listPendingSessionRequests';

export type PendingRequestObservedAtCacheEntry = Readonly<{
    sessionSignature: string;
    sessionMessagesSignature: string;
    value: number | null;
}>;

export function prunePendingRequestObservedAtCache(
    cache: Map<string, PendingRequestObservedAtCacheEntry>,
    activeSessionIds: ReadonlySet<string>,
): void {
    for (const cachedId of cache.keys()) {
        if (!activeSessionIds.has(cachedId)) {
            cache.delete(cachedId);
        }
    }
}

export function readCachedPendingRequestObservedAt(params: Readonly<{
    cache: Map<string, PendingRequestObservedAtCacheEntry>;
    session: Session;
    sessionMessages: StorageState['sessionMessages'][string] | undefined;
    sessionSignature: string;
    sessionMessagesSignature: string;
}>): number | null {
    const cached = params.cache.get(params.session.id);
    if (
        cached?.sessionSignature === params.sessionSignature
        && cached.sessionMessagesSignature === params.sessionMessagesSignature
    ) {
        return cached.value;
    }

    const value = deriveLatestPendingRequestObservedAtFromSession(
        params.session,
        readStoredSessionMessagesFromStateLike(params.sessionMessages),
    );
    params.cache.set(params.session.id, {
        sessionSignature: params.sessionSignature,
        sessionMessagesSignature: params.sessionMessagesSignature,
        value,
    });
    return value;
}
