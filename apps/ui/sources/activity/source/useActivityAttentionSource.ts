import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import {
    getActiveServerSnapshot,
    getServerProfilesGeneration,
    listServerProfiles,
    subscribeActiveServer,
    subscribeServerProfiles,
} from '@/sync/domains/server/serverProfiles';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { createActivityAttentionStoreSourceSelector } from './createActivityAttentionStoreSourceSelector';

function getServerSourceGeneration(): string {
    return `${getServerProfilesGeneration()}:${getActiveServerSnapshot().generation}`;
}

export function useActivityAttentionSource(): ActivityAttentionSource {
    const storeSourceSelectorRef = React.useRef<ReturnType<typeof createActivityAttentionStoreSourceSelector> | null>(null);
    if (!storeSourceSelectorRef.current) {
        storeSourceSelectorRef.current = createActivityAttentionStoreSourceSelector();
    }
    const serverSourceGeneration = React.useSyncExternalStore(
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
    const storeSource = storage(storeSourceSelectorRef.current);
    const serverSource = React.useMemo(() => ({
        serverProfilesById: Object.fromEntries(listServerProfiles().map((profile) => [profile.id, profile])),
        activeServer: getActiveServerSnapshot(),
    }), [serverSourceGeneration]);

    return React.useMemo(() => ({
        ...storeSource,
        ...serverSource,
    }), [serverSource, storeSource]);
}
