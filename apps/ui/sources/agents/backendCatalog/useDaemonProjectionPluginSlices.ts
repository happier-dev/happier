import * as React from 'react';

import type { PluginContributedActionPluginSlices } from '@/components/plugins/actions/pluginContributedActionController';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { pluginSliceSections } from '@/sync/domains/plugins/ui/projectionSections';

import { loadDaemonMergedProjectionCacheEntry, readCachedDaemonMergedProjectionCacheEntry,
    readDaemonProjectionActionPlugins, subscribeDaemonMergedProjectionSummary } from './loadDaemonMergedProjectionInputs';

const HELD_ANSWER: readonly string[] = Object.freeze([]);

/**
 * The not-loaded state for a holder of a Session's plugin slices. `isLoaded`
 * reads the Machine's held coverage; `load` reads one plugin's slice through
 * the canonical loader and settles once the holder has committed a render of
 * that answer, so a re-resolution sees the snapshot that carries the slice.
 * Null when the holder has no Machine.
 */
export function useDaemonProjectionPluginSlices(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null | undefined;
}>): PluginContributedActionPluginSlices | null {
    const { machineId, serverId, accountLifetime } = params;
    const subscribe = React.useCallback((listener: () => void) => machineId
        ? subscribeDaemonMergedProjectionSummary({ machineId, serverId }, listener) : () => {}, [machineId, serverId]);
    // The held answer at any coverage: an omitted demand would mean the complete catalogue.
    const readEntry = React.useCallback(() => machineId
        ? readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId, sections: HELD_ANSWER }) : null, [machineId, serverId]);
    // Every publication of this Machine's answer commits the holder, so a
    // settled slice read never waits on a commit that already happened.
    const entry = React.useSyncExternalStore(subscribe, readEntry, readEntry);
    const committedEntry = React.useRef<unknown>(undefined);
    const waiters = React.useRef(new Set<() => void>());
    React.useLayoutEffect(() => {
        committedEntry.current = entry;
        for (const release of [...waiters.current]) release();
    }, [entry]);
    return React.useMemo(() => {
        if (!machineId) return null;
        const isLoaded = (pluginId: string) => {
            const plugins = readDaemonProjectionActionPlugins({ machineId, serverId });
            return plugins === 'all' || plugins?.has(pluginId) === true;
        };
        return Object.freeze({
            isLoaded,
            async load(pluginId: string, signal?: AbortSignal) {
                if (isLoaded(pluginId)) return;
                await loadDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId ?? null,
                    accountLifetime: accountLifetime ?? null, sections: pluginSliceSections(pluginId), reuseFreshReady: true,
                    ...(signal ? { signal } : {}) });
                const published = readEntry();
                // Settle once the holder has committed the answer this read published.
                if (committedEntry.current === published || signal?.aborted) return;
                await new Promise<void>(resolve => {
                    const release = () => {
                        if (committedEntry.current !== published && readEntry() === published && !signal?.aborted) return;
                        waiters.current.delete(release);
                        signal?.removeEventListener('abort', release);
                        resolve();
                    };
                    waiters.current.add(release);
                    signal?.addEventListener('abort', release, { once: true });
                });
            },
        });
    }, [accountLifetime, machineId, readEntry, serverId]);
}
