import * as React from 'react';
import type { SettingsCollectionFilter } from '@/components/settings/shell/settingsCollectionAdapter';
import { useSettingsColumnFilter, type SettingsColumnFilterField } from '@/components/settings/shell/useSettingsColumnFilter';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useRegistrySources } from '@/registries/useRegistrySources';
import type { RegistryCuration } from '@/registries/useRegistrySuggestions';
import { useStoreDirectoryState } from '@/components/settings/plugins/model/usePluginsOpenItem';
import { StoreAppKind, StoreBrowserExtensionKind, StoreMcpKind, StoreSkillKind, StoreAgentKind, StoreProviderKind, StorePluginKind, StoreSoftwareKind,
    type StoreKindList } from './StoreKindScreen';
import { storeKinds, STORE_KIND_ORDER, type StoreDemand, type StoreKind, type StoreListInput } from './catalog/storeKinds';
import { storeColumnAdapter, storeDemandMatches, storeRowFacts, type StoreColumnField, type StoreSearchRow } from './catalog/storeColumnAdapter';

export type StoreSearchLists = Readonly<{ [Kind in StoreKind]?: StoreKindList<Kind> }>;
type StoreFilter = ReturnType<typeof useSettingsColumnFilter<StoreColumnField>>;
export type StoreSearchState = Readonly<{
    /** Collection items are the native producer rows, retaining their identity without reconciliation here. */
    rows: readonly StoreSearchRow['summary']['ref'][];
    projections: ReadonlyMap<StoreSearchRow['summary']['ref'], StoreSearchRow>;
    lists: StoreSearchLists;
    query: string;
    setQuery: (query: string) => void;
    filter: StoreFilter;
}>;
type StoreSearchProps = Readonly<{
    demand: StoreDemand;
    kind?: StoreKind;
    sourceIds?: readonly string[];
    softwareTarget?: StoreListInput['softwareTarget'];
    fields: Readonly<Record<StoreColumnField, SettingsColumnFilterField>>;
    /** The Discover owner supplies its single admitted curation; this composition never reacquires it. */
    curation?: RegistryCuration['curation'];
    curationComplete?: boolean;
    initialQuery?: string;
    initialFilters?: SettingsCollectionFilter;
    /** A route owner can retain this same draft through page/phone navigation. */
    draft?: Readonly<{ query: string; setQuery: (query: string) => void;
        filters: SettingsCollectionFilter; setFilters: React.Dispatch<React.SetStateAction<SettingsCollectionFilter>> }>;
    /** Conditions a page control already states (the search page's kind segment): no second token for them. */
    statedFields?: readonly StoreColumnField[];
    children: (state: StoreSearchState) => React.ReactNode;
}>;
const EMPTY_CURATION: RegistryCuration['curation'] = [];

/** All Store directories compile catalog conditions before admitting registry reads. */
export function useStoreDirectorySources(filters: SettingsCollectionFilter, presented: boolean, allowed?: readonly string[]) {
    const sources = useRegistrySources(undefined, presented);
    const sourceIds = React.useMemo(() => filters.source === undefined ? allowed : sources.sources.filter(source =>
        source.enabled && (allowed === undefined || allowed.includes(source.id))
        && storeDemandMatches(filters, { source: [source.id] })).map(source => source.id),
    [filters.source, allowed, sources.sources]);
    return { ...sources, sourceIds };
}

/** Route-backed directory entry; invalid conditions retain their clear/recovery surface. */
export function StoreDirectory(props: Omit<StoreSearchProps, 'draft' | 'initialQuery' | 'initialFilters'> & Readonly<{
    unavailable: React.ReactNode;
}>): React.ReactNode {
    const directory = useStoreDirectoryState();
    if (!directory.state) return props.unavailable;
    return <StoreSearch {...props} draft={{ ...directory.state,
        setQuery: directory.setQuery, setFilters: directory.setFilters }} />;
}

/** Data/control composition only. S40-UI supplies the shared Collection and all visual slots. */
export function StoreSearch(props: StoreSearchProps): React.ReactNode {
    const lifetime = useActiveServerAccountScopeLifetime();
    const key = lifetime ? JSON.stringify([lifetime.scope.serverId, lifetime.scope.accountId]) : 'unavailable';
    return <StoreSearchScope key={key} {...props} demand={{ presented: props.demand.presented && !!lifetime?.isCurrent() }} />;
}

function StoreSearchScope(props: StoreSearchProps): React.ReactNode {
    const [localQuery, setLocalQuery] = React.useState(props.initialQuery ?? '');
    const [localFilters, setLocalFilters] = React.useState<SettingsCollectionFilter>(props.initialFilters ?? {});
    const { query, setQuery, filters, setFilters } = props.draft ?? {
        query: localQuery, setQuery: setLocalQuery, filters: localFilters, setFilters: setLocalFilters,
    };
    const sources = useStoreDirectorySources(filters, props.demand.presented, props.sourceIds);
    const { sourceIds } = sources;
    const kinds = STORE_KIND_ORDER.filter(kind => (!props.kind || props.kind === kind) && storeDemandMatches(filters, { kind: [kind] })
        && (kind !== 'provider' && kind !== 'software' || sourceIds === undefined && storeDemandMatches(filters, { source: null })));
    const input = React.useMemo<StoreListInput>(() => ({ query, sourceIds, softwareTarget: props.softwareTarget }), [query, sourceIds, props.softwareTarget]);
    const render = (lists: StoreSearchLists) => <StoreSearchResults {...props} query={query} setQuery={setQuery}
        draft={{ filters, setFilters }} lists={lists}
        corpusIncomplete={sources.loading || !sources.hasValue || sources.error !== null} />;

    // Only demanded kinds mount. Explicit all-kind search uses these fixed leaves, never runtime hook dispatch.
    const software = (lists: StoreSearchLists) => kinds.includes('software')
        ? <StoreSoftwareKind input={input} demand={props.demand}>{list => render({ ...lists, software: list })}</StoreSoftwareKind> : render(lists);
    const plugin = (lists: StoreSearchLists) => kinds.includes('plugin')
        ? <StorePluginKind input={input} demand={props.demand}>{list => software({ ...lists, plugin: list })}</StorePluginKind> : software(lists);
    const provider = (lists: StoreSearchLists) => kinds.includes('provider')
        ? <StoreProviderKind input={input} demand={props.demand}>{list => plugin({ ...lists, provider: list })}</StoreProviderKind> : plugin(lists);
    const agent = (lists: StoreSearchLists) => kinds.includes('agent')
        ? <StoreAgentKind input={input} demand={props.demand}>{list => provider({ ...lists, agent: list })}</StoreAgentKind> : provider(lists);
    const skill = (lists: StoreSearchLists) => kinds.includes('skill')
        ? <StoreSkillKind input={input} demand={props.demand}>{list => agent({ ...lists, skill: list })}</StoreSkillKind> : agent(lists);
    const mcp = (lists: StoreSearchLists) => kinds.includes('mcpServer')
        ? <StoreMcpKind input={input} demand={props.demand}>{list => skill({ ...lists, mcpServer: list })}</StoreMcpKind> : skill(lists);
    const browserExtension = (lists: StoreSearchLists) => kinds.includes('browserExtension')
        ? <StoreBrowserExtensionKind input={input} demand={props.demand}>{list => mcp({ ...lists, browserExtension: list })}</StoreBrowserExtensionKind> : mcp(lists);
    return kinds.includes('app')
        ? <StoreAppKind input={input} demand={props.demand}>{list => browserExtension({ app: list })}</StoreAppKind> : browserExtension({});
}

function StoreSearchResults(props: Omit<StoreSearchProps, 'draft'> & Readonly<{
    lists: StoreSearchLists;
    query: string;
    setQuery: (query: string) => void;
    draft: NonNullable<Parameters<typeof useSettingsColumnFilter<StoreColumnField>>[0]['draft']>;
    corpusIncomplete: boolean;
}>): React.ReactNode {
    const { lists } = props;
    const rows = React.useMemo<readonly StoreSearchRow[]>(() => [
        ...(lists.app?.items.map(item => ({ kind: 'app' as const, summary: storeKinds.app.summary(item) })) ?? []),
        ...(lists.browserExtension?.items.map(item => ({ kind: 'browserExtension' as const, summary: storeKinds.browserExtension.summary(item) })) ?? []),
        ...(lists.mcpServer?.items.map(item => ({ kind: 'mcpServer' as const, summary: storeKinds.mcpServer.summary(item) })) ?? []),
        ...(lists.skill?.items.map(item => ({ kind: 'skill' as const, summary: storeKinds.skill.summary(item) })) ?? []),
        ...(lists.agent?.items.map(item => ({ kind: 'agent' as const, summary: storeKinds.agent.summary(item) })) ?? []),
        ...(lists.provider?.items.map(item => ({ kind: 'provider' as const, summary: storeKinds.provider.summary(item) })) ?? []),
        ...(lists.plugin?.items.map(item => ({ kind: 'plugin' as const, summary: storeKinds.plugin.summary(item) })) ?? []),
        ...(lists.software?.items.map(item => ({ kind: 'software' as const, summary: storeKinds.software.summary(item) })) ?? []),
    ].map(row => ({ ...row, key: JSON.stringify([row.kind, row.summary.key]) })),
    [lists.app?.items, lists.browserExtension?.items, lists.mcpServer?.items, lists.skill?.items, lists.agent?.items, lists.provider?.items, lists.plugin?.items, lists.software?.items]);
    const curation = props.curation ?? EMPTY_CURATION;
    const facts = React.useMemo(() => storeRowFacts(rows, curation, props.curationComplete === true),
        [rows, curation, props.curationComplete]);
    const incomplete = props.corpusIncomplete || Object.values(lists).some(list => list.loading || list.stale || list.hasNextPage
        || 'error' in list && list.error !== null
        || 'pages' in list && list.pages.some(page => page.status.state !== 'ok')
        || 'sourceStatuses' in list && list.sourceStatuses.some(source => source.freshness !== 'fresh'));
    const filter = useSettingsColumnFilter({ column: 'store', presented: props.demand.presented,
        testIDPrefix: 'store.filter', adapter: storeColumnAdapter, fields: props.fields, facts,
        draft: props.draft, search: { value: props.query, set: props.setQuery }, corpusCoverage: incomplete ? 'partial' : 'complete',
        ...(props.statedFields ? { statedFields: props.statedFields } : {}) });
    const visible = rows.filter(row => filter.matches(row.key));
    // These are current-render display bindings, not retained row objects or an identity cache.
    const projections = new Map(rows.map(row => [row.summary.ref, row]));
    return props.children({ rows: visible.map(row => row.summary.ref), projections, lists, query: props.query, setQuery: props.setQuery, filter });
}
