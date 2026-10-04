import type { SessionBoardItemProjection, SessionBoardSnapshot } from './sessionBoardProjection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { sessionBoardSourceRequiresExclusiveMount } from './sessionBoardPrimaryMount';

/**
 * The exact currentness proof an executable Session item may consume.
 *
 * Last-known Board bytes remain useful while stale or offline, but they are not
 * authority to keep a frame, plugin Host API, or Resource watch alive. An
 * installed surface additionally needs the current interactive plugin
 * projection that supplies its code and authority. This projection deliberately
 * ignores `incomplete`: a current exact item need not stop merely because a later
 * inventory page is still loading.
 */
export type SessionBoardExecutableCurrentness =
    | 'current'
    | 'stale'
    | 'offline'
    | 'unverified'
    | 'not_executable';

export function resolveSessionBoardExecutableCurrentness(
    snapshot: SessionBoardSnapshot,
    item: SessionBoardItemProjection,
    pluginRuntime?: Pick<
        PluginUiProjectionCurrentness,
        'pluginUiProjection' | 'phase' | 'interactionEnabled'
    > | null,
): SessionBoardExecutableCurrentness {
    if (item.state.kind !== 'ready' || !sessionBoardSourceRequiresExclusiveMount(item.state.item.source.kind)) {
        return 'not_executable';
    }
    if (!snapshot.capabilities.readTranscript) return 'unverified';
    if (snapshot.reachability === 'offline') return 'offline';
    if (snapshot.reachability !== 'reachable') return 'unverified';
    if (snapshot.freshness !== 'fresh') return 'stale';

    const current = snapshot.itemsById.get(item.itemId);
    if (!current || current.revision === null || current.revision !== item.revision
        || current.state.kind !== 'ready') {
        return 'unverified';
    }
    if (item.state.item.source.kind === 'installedSurface') {
        if (!pluginRuntime || pluginRuntime.phase === 'unavailable') return 'unverified';
        if (pluginRuntime.phase === 'retainedOffline') return 'offline';
        if (pluginRuntime.phase === 'establishing') return 'stale';
        if (!pluginRuntime.pluginUiProjection || !pluginRuntime.interactionEnabled) return 'unverified';
    }
    return 'current';
}
