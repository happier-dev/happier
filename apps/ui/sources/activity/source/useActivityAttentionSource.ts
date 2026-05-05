import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { storage } from '@/sync/domains/state/storage';
import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import {
    getActiveServerSnapshot,
    getServerProfilesGeneration,
    listServerProfiles,
    subscribeActiveServer,
    subscribeServerProfiles,
} from '@/sync/domains/server/serverProfiles';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';

const EMPTY_INDEX_BY_SERVER_ID: ActivityAttentionSource['sessionListIndexByServerId'] = {};
const EMPTY_RENDERABLES_BY_ID: ActivityAttentionSource['sessionListRenderablesById'] = {};
const EMPTY_CONCURRENT_CACHE_BY_SERVER_ID: ConcurrentSessionListCacheByServerId = {};

function getServerSourceGeneration(): string {
    return `${getServerProfilesGeneration()}:${getActiveServerSnapshot().generation}`;
}

export function useActivityAttentionSource(): ActivityAttentionSource {
    React.useSyncExternalStore(
        React.useCallback((listener) => {
            const unsubscribeProfiles = subscribeServerProfiles(listener);
            const unsubscribeActive = subscribeActiveServer(() => listener());
            return () => {
                unsubscribeProfiles();
                unsubscribeActive();
            };
        }, []),
        getServerSourceGeneration,
        getServerSourceGeneration,
    );
    const source = storage(useShallow((state) => ({
        isDataReady: state.isDataReady,
        sessionsById: state.sessions,
        sessionListRenderablesById: state.sessionListRenderables ?? EMPTY_RENDERABLES_BY_ID,
        sessionListIndexByServerId: state.sessionListIndexByServerId ?? EMPTY_INDEX_BY_SERVER_ID,
        concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId ?? EMPTY_CONCURRENT_CACHE_BY_SERVER_ID,
        serverProfilesById: Object.fromEntries(listServerProfiles().map((profile) => [profile.id, profile])),
        activeServer: getActiveServerSnapshot(),
    })));

    return React.useMemo(() => source, [source]);
}
