import type { PluginReadOnlySnapshotNoticeState } from './pluginMarketplaceModel';

/**
 * What the Plugins collection shows instead of (or with) its plugins. Every state is terminal or
 * bounded by a real read, so the page never waits on something that can fail silently:
 * - `noTarget`: no machine is chosen, nothing was read;
 * - `loading`: the machine has not answered yet (the grid's shape holds the layout);
 * - `readFailed`: the machine is reachable but its plugin list did not load (Retry);
 * - `offline`: the machine went away; its last-known plugins stay, read-only;
 * - `empty`: the machine answered with nothing installed;
 * - `noMatch`: a search or filter hid every plugin (said only while something is searched);
 * - `ready`: plugins to show, with any read-only notice above them.
 */
export type PluginsCollectionState = 'noTarget' | 'loading' | 'readFailed' | 'offline' | 'empty' | 'noMatch' | 'ready';

export function resolvePluginsCollectionState(params: Readonly<{
    noTarget: boolean;
    noticeReason: PluginReadOnlySnapshotNoticeState['reason'] | null;
    /** The machine answered the installed-plugins read (the list below is its answer). */
    listRead: boolean;
    itemCount: number;
    visibleCount: number;
    filtering: boolean;
}>): PluginsCollectionState {
    if (params.noTarget) return 'noTarget';
    if (params.noticeReason === 'disconnected') {
        return params.itemCount > 0 && params.filtering && params.visibleCount === 0 ? 'noMatch' : 'offline';
    }
    if (params.itemCount > 0) return params.filtering && params.visibleCount === 0 ? 'noMatch' : 'ready';
    if (!params.listRead) {
        return params.noticeReason === 'installationUnavailable' || params.noticeReason === 'projectionUnavailable'
            ? 'readFailed'
            : 'loading';
    }
    return params.filtering ? 'noMatch' : 'empty';
}
