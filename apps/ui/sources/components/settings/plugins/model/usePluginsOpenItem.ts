import * as React from 'react';
import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { reconcileMcpAddDraftContinuation, releaseMcpAddDraftContinuation, retainMcpAddDraftContinuation } from '@/components/settings/mcpServers/add/mcpAddDraftState';

import {
    buildPluginsHomeRoute,
    isPluginsHomePathname,
    pluginsOpenItemParams,
    readPluginsOpenItem,
    resolvePluginsSurfaceHost,
    readStoreOpenItem,
    storeOpenItemParams,
    buildStoreListingRoute,
    readStoreDirectoryRoute,
    readStoreProjectRoute,
    readStoreMachineRoute,
    type PluginsOpenItem,
} from './pluginsSurfaceRoutes';

type NavigationHref = Parameters<ReturnType<typeof useRouter>['replace']>[0];

/**
 * The one owner of which plugin is open beside the Plugins page. The Plugins column, the grid and the
 * list read and change the same route params (`pluginsOpenItemParams`), so they always mark the same
 * plugin and the detail pane shows it.
 *
 * On the Plugins home the selection changes in place (`setParams`), so the page keeps its view,
 * search, filters and scroll. From another Plugins page (a listing, a plugin's own page) opening a
 * plugin returns to the home of the same host with it open.
 */
export function usePluginsOpenItem(continuationId?: string) {
    React.useEffect(() => () => releaseMcpAddDraftContinuation(continuationId), [continuationId]);
    const router = useRouter();
    const pathname = usePathname();
    const params = useGlobalSearchParams<{ view?: string; plugin?: string; source?: string; itemId?: string; version?: string; selection?: string; project?: string; machine?: string }>();
    const project = React.useMemo(() => readStoreProjectRoute(params), [params.project]);
    const machine = React.useMemo(() => readStoreMachineRoute(params), [params.machine]);
    const onHome = isPluginsHomePathname(pathname);
    const openItem = onHome ? readPluginsOpenItem(params) : null;
    const view = params.view === 'browse' ? 'browse' as const : 'installed' as const;
    const host = resolvePluginsSurfaceHost(pathname);

    const open = React.useCallback((item: PluginsOpenItem | null) => {
        const result = runGuardedNavigation(() => {
            if (onHome) router.setParams(pluginsOpenItemParams(item));
            else router.replace(buildPluginsHomeRoute(host, { view, open: item, project: host === 'app' ? project : null, machine: host === 'app' ? machine : null }) as NavigationHref);
        });
        if (result !== true) fireAndForget(result, { tag: 'usePluginsOpenItem.open' });
    }, [host, onHome, router, view, project, machine]);
    const close = React.useCallback(() => open(null), [open]);
    const storeSelection = params.selection;
    const storeOpenItem = React.useMemo(() => readStoreOpenItem({ selection: storeSelection }), [storeSelection]);
    React.useEffect(() => reconcileMcpAddDraftContinuation(continuationId, storeOpenItem), [continuationId, storeOpenItem]);
    const storeSelectionUnavailable = storeSelection !== undefined && storeOpenItem === null;
    const openStore = React.useCallback((item: ReturnType<typeof readStoreOpenItem>) => {
        const result = runGuardedNavigation(() => router.setParams(storeOpenItemParams(item)));
        if (result !== true) fireAndForget(result, { tag: 'usePluginsOpenItem.openStore' });
    }, [router]);
    const closeStore = React.useCallback(() => {
        releaseMcpAddDraftContinuation(continuationId);
        openStore(null);
    }, [continuationId, openStore]);
    const openStoreAsPage = React.useCallback(() => {
        if (!storeOpenItem) return;
        const result = runGuardedNavigation(() => {
            retainMcpAddDraftContinuation(continuationId);
            // Back returns to the directory, including when it no longer has room for a pane.
            router.setParams(storeOpenItemParams(null));
            router.pushRetainingCurrent(buildStoreListingRoute(storeOpenItem, project, continuationId, machine));
        });
        if (result !== true) fireAndForget(result, { tag: 'usePluginsOpenItem.openStoreAsPage' });
    }, [router, storeOpenItem, project, continuationId, machine]);

    // Stable while the same item stays open, so consumers can depend on it.
    const pluginId = openItem?.pluginId ?? null;
    const sourceId = openItem?.kind === 'listing' ? openItem.sourceId : null;
    const itemId = openItem?.kind === 'listing' ? openItem.itemId : undefined;
    const version = openItem?.kind === 'listing' ? openItem.version : undefined;
    const stableOpenItem = React.useMemo((): PluginsOpenItem | null => {
        if (pluginId === null) return null;
        return sourceId === null ? { kind: 'installed', pluginId } : { kind: 'listing', sourceId, pluginId,
            ...(itemId ? { itemId } : {}), ...(version ? { version } : {}) };
    }, [pluginId, sourceId, itemId, version]);
    return { openItem: stableOpenItem, open, close, storeOpenItem, storeSelectionUnavailable, openStore, closeStore, openStoreAsPage } as const;
}

/** Transient directory state belongs to the existing route/history, never Account settings. */
export function useStoreDirectoryState() {
    const router = useRouter();
    const params = useGlobalSearchParams<{ q?: string; filters?: string }>();
    const state = React.useMemo(() => readStoreDirectoryRoute(params), [params.q, params.filters]);
    const latest = React.useRef(state);
    latest.current = state;
    const setQuery = React.useCallback((query: string) => router.setParams({ q: query || undefined }), [router]);
    const setFilters = React.useCallback<React.Dispatch<React.SetStateAction<NonNullable<typeof state>['filters']>>>(update => {
        if (typeof update === 'function' && !latest.current) return;
        const filters = typeof update === 'function' ? update(latest.current!.filters) : update;
        if (latest.current) latest.current = { ...latest.current, filters };
        router.setParams({ filters: Object.keys(filters).length ? JSON.stringify(filters) : undefined });
    }, [router]);
    return { state, setQuery, setFilters } as const;
}
