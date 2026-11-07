import * as React from 'react';
import { registryMarketplaceSourceV1, registryPluginSummaryV1, type RegistryItemV1, type RegistryItemPointerV1 } from '@happier-dev/protocol/registries';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { t } from '@/text';
import { projectRegistryMarketplacePage, type PluginMarketplaceDiscoverPage,
    type PluginMarketplaceCatalogSourceKind } from '../readPluginMarketplaceCatalog';
import type { PluginListingRouteParams } from './pluginsSurfaceRoutes';
import type { RegistryFailureStatus } from '@/registries/describeRegistrySourceStatus';

type CatalogSelection = PluginListingRouteParams | Readonly<Omit<RegistryItemPointerV1, 'version'> & { version?: string }>;
type CatalogQuery = Readonly<{ text: string; sourceId: string | null; sourceIds?: readonly string[]; listing?: CatalogSelection }>;

export type PluginCatalogState = Readonly<{
    execution: ReturnType<typeof useMountedActionExecution>;
    accountKey: string | null;
    current: boolean;
    selectedItem: RegistryItemV1 | null;
    unresolvedListing: boolean;
    resolveInstallEntry: (listing: Readonly<{ pluginId: string; sourceId?: string }>) => PluginMarketplaceDiscoverPage['entries'][number] | null;
    discoverEntries: PluginMarketplaceDiscoverPage['entries'];
    discoverNextCursor: string | null;
    discoverSources: readonly Readonly<{ id: string; title: string; kind: PluginMarketplaceCatalogSourceKind }>[];
    discoverSourceStatuses: PluginMarketplaceDiscoverPage['sources'];
    discoverDiagnostics: PluginMarketplaceDiscoverPage['diagnostics'];
    discoverNonInstallable: PluginMarketplaceDiscoverPage['nonInstallable'];
    discoverSearchText: string;
    setDiscoverSearchText: (text: string) => void;
    selectedDiscoverSourceId: string | null;
    discoverResultsSearchText: string | null;
    discoverStale: boolean;
    loadingDiscover: boolean;
    loadingMoreDiscover: boolean;
    discoverError: string | null;
    discoverFailureStatus: RegistryFailureStatus | null;
    canRefreshDiscover: boolean;
    refreshDiscover: () => void;
    clearDiscoverSearch: () => void;
    setSelectedDiscoverSourceId: (sourceId: string | null) => void;
    openDiscoverListing: (selection: PluginListingRouteParams) => void;
    loadMoreDiscover: () => void;
}>;

type PluginCatalogParams = Readonly<{
    enabled?: boolean;
    browse?: boolean;
    selection?: CatalogSelection;
    /** Shared Add uses the same producer with its mounted search/source draft. */
    query?: Readonly<{ text: string; sourceId: string | null; sourceIds?: readonly string[] }>;
    initialSourceId?: string;
}>;

/** Account-owned catalog acquisition. Browsing never loads bodies or install-Machine facts. */
export function usePluginCatalog(params: PluginCatalogParams = {}): PluginCatalogState {
    const sources = useRegistrySources('plugin', params.enabled !== false);
    return usePluginCatalogWithSources(params, sources);
}

/** A composed Add surface shares its already admitted descriptors with list and detail. */
export function usePluginCatalogWithSources(params: PluginCatalogParams, sources: ReturnType<typeof useRegistrySources>): PluginCatalogState {
    const enabled = params.enabled !== false;
    const server = useActiveServerSnapshot();
    const execution = useMountedActionExecution(server.serverId);
    const accountKey = execution.binding ? JSON.stringify([execution.binding.scope.serverId, execution.binding.scope.accountId]) : null;
    const [searchText, setSearchText] = React.useState('');
    const [sourceId, setSourceId] = React.useState<string | null>(params.initialSourceId ?? null);
    const [requested, setRequested] = React.useState<Readonly<{ accountKey: string | null; query: CatalogQuery }> | null>(null);
    const desired = React.useMemo<CatalogQuery | null>(() => params.selection
        ? { text: '', sourceId: params.selection.sourceId, listing: params.selection }
        : params.query ?? (requested?.accountKey === accountKey ? requested.query : null),
    [params.selection, params.query?.text, params.query?.sourceId, params.query?.sourceIds, requested, accountKey]);
    const listing = desired?.listing;
    const pluginId = listing && 'pluginId' in listing ? listing.pluginId : undefined;
    const browse = useRegistryItems({ kind: 'plugin', ...(desired?.sourceIds ? { sourceIds: desired.sourceIds }
        : desired?.sourceId ? { sourceIds: [desired.sourceId] } : {}),
        query: desired?.text.trim() ?? '' }, enabled && desired !== null && !listing && execution.ready);
    const source = sources.sources.find(source => source.enabled && source.id === listing?.sourceId);
    const admitted = listing && (!listing.itemId || !listing.version) && browse.items.find(item => item.sourceId === listing.sourceId
        && item.pluginListing?.pluginId === pluginId && (!listing.version || item.version === listing.version));
    // npm item ids are package names; a cold Plugin-id-only link has no inverse locator.
    const itemId = listing?.itemId ?? (admitted ? admitted.itemId : source?.format === 'happier-catalog' ? pluginId : undefined);
    const version = listing?.version ?? (admitted ? admitted.version : undefined);
    const selected = useRegistryItem({ kind: 'plugin', sourceId: source && itemId !== undefined ? source.id : '',
        itemId: itemId ?? '', ...(version ? { version } : {}) }, enabled && !!listing && !!source && itemId !== undefined);
    const selectedItem = enabled && listing && !selected.stale && selected.item?.payload.kind === 'plugin'
        && selected.item.summary.sourceId === listing.sourceId && selected.item.summary.itemId === itemId
        && (!version || selected.item.summary.version === version) && (!pluginId || selected.item.payload.listing.pluginId === pluginId)
        ? selected.item : null;
    const unresolvedListing = !!listing && !sources.loading && itemId === undefined;
    const selectedSummary = React.useMemo(() => selectedItem && source && !('packageContent' in source) && selectedItem.payload.kind === 'plugin'
        ? selectedItem.summary.pluginListing ? selectedItem.summary : registryPluginSummaryV1(source, selectedItem.payload.listing)
        : null, [selectedItem, source]);
    const projection = React.useRef<Parameters<typeof projectRegistryMarketplacePage>[1]>(undefined);
    const page = React.useMemo(() => {
        const input = {
            items: !enabled || !desired ? [] : listing ? selectedSummary ? [selectedSummary] : [] : browse.items,
            pages: !enabled || !desired || listing ? [] : browse.pages, sources: sources.sources,
        };
        const page = projectRegistryMarketplacePage(input, projection.current);
        projection.current = { input, page };
        return page;
    }, [enabled, desired?.text, desired?.sourceId, desired?.sourceIds, listing?.sourceId, pluginId, listing?.itemId, listing?.version,
        selectedSummary, browse.items, browse.pages, sources.sources]);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [pagingError, setPagingError] = React.useState<string | null>(null);
    const refresh = listing ? selected.refresh : browse.refresh;
    const request = React.useCallback((query: CatalogQuery) => {
        setPagingError(null);
        if (requested?.accountKey === accountKey && JSON.stringify(requested.query) === JSON.stringify(query)) void refresh();
        else setRequested({ accountKey, query });
    }, [accountKey, requested, refresh]);
    const seededListing = params.selection !== undefined;
    const refreshDiscover = React.useCallback(() => {
        if (seededListing) void selected.refresh();
        else if (params.query) void browse.refresh();
        else request({ text: searchText, sourceId });
    }, [seededListing, selected.refresh, params.query, browse.refresh, request, searchText, sourceId]);
    const setSelectedDiscoverSourceId = React.useCallback((next: string | null) => {
        setSourceId(next); request({ text: searchText, sourceId: next });
    }, [request, searchText]);
    const clearDiscoverSearch = React.useCallback(() => {
        setSearchText(''); request({ text: '', sourceId });
    }, [request, sourceId]);
    const openDiscoverListing = React.useCallback((selection: PluginListingRouteParams) => {
        setSourceId(selection.sourceId); request({ text: '', sourceId: selection.sourceId, listing: selection });
    }, [request]);
    const loadMoreDiscover = React.useCallback(() => {
        if (listing || !browse.hasNextPage || browse.loading || loadingMore) return;
        setLoadingMore(true);
        void browse.nextPage().catch(() => {
            if (execution.isCurrent()) setPagingError(t('settingsPlugins.discover.diagnostic.recovery'));
        }).finally(() => { if (execution.isCurrent()) setLoadingMore(false); });
    }, [listing, browse.hasNextPage, browse.loading, browse.nextPage, loadingMore, execution.isCurrent]);
    React.useEffect(() => {
        setSearchText(''); setSourceId(params.initialSourceId ?? null); setRequested(null); setPagingError(null); setLoadingMore(false);
    }, [accountKey, params.initialSourceId]);
    React.useEffect(() => {
        if (enabled && params.browse && execution.ready && accountKey && desired === null) refreshDiscover();
    }, [enabled, params.browse, execution.ready, accountKey, desired, refreshDiscover]);
    const loading = enabled && desired !== null && (!execution.ready || (listing
        ? sources.loading || itemId !== undefined && selected.loading : browse.loading));
    const current = enabled && execution.ready && desired !== null && (listing ? selectedItem !== null : !browse.stale);
    const resolveInstallEntry = React.useCallback((listing: Readonly<{ pluginId: string; sourceId?: string }>) => {
        const entry = page.entries.find(entry => entry.id === listing.pluginId && entry.sourceId === listing.sourceId);
        return current && entry?.installable && entry.version ? entry : null;
    }, [current, page.entries]);
    const discoverSources = React.useMemo(() => sources.sources.flatMap(source => {
        if ('packageContent' in source || !source.enabled) return [];
        return [{ id: source.id, title: source.title, kind: registryMarketplaceSourceV1(source).kind }];
    }), [sources.sources]);
    return { execution, accountKey, current, selectedItem, unresolvedListing, resolveInstallEntry,
        discoverEntries: page.entries, discoverNextCursor: page.nextCursor, discoverSources,
        discoverSourceStatuses: page.sources, discoverDiagnostics: page.diagnostics, discoverNonInstallable: page.nonInstallable,
        discoverSearchText: searchText, setDiscoverSearchText: setSearchText, selectedDiscoverSourceId: sourceId,
        discoverResultsSearchText: desired && !browse.stale ? desired.text.trim() : null,
        discoverStale: !listing && (browse.stale || !params.query && desired !== null
            && (desired.text.trim() !== searchText.trim() || desired.sourceId !== sourceId)),
        loadingDiscover: loading, loadingMoreDiscover: loadingMore,
        discoverError: pagingError ?? (listing ? selected.error : browse.error),
        discoverFailureStatus: listing ? selected.status : browse.status,
        canRefreshDiscover: execution.ready && !loading && !loadingMore,
        refreshDiscover, clearDiscoverSearch, setSelectedDiscoverSourceId, openDiscoverListing, loadMoreDiscover,
    };
}
