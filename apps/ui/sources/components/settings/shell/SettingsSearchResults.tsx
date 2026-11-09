import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Item } from '@/components/ui/lists/Item';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import {
    CollectionListGroupLabel,
    CollectionNavigationRow,
} from '@/components/ui/lists/collection/CollectionList';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveHappierCollectionListRowPadding } from '@happier-dev/plugin-ui/presentation';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode, SettingsPageSearchResult } from '@/components/settings/catalog/types';

import { buildSettingsSearchRows, indexSettingsSearchPages, type SettingsSearchRow } from './settingsSearchRows';
import { SETTINGS_SEARCH_RETURN_QUERY_PARAM } from '@/components/settings/navigation/settingsRouteRegistry';
import type { SettingsPageSearchQuery } from './SettingsPageSearchContext';

/**
 * Settings search, shared by the desktop rail and the phone Settings page: one query, one result
 * list from the catalog owner, one way to open a result (guarded against unsaved work).
 */
export function useSettingsSearch(options: Readonly<{
    tag: string;
} & (
    /** Rail queries stay local and clear once a result opens. */
    { clearOnOpen: true }
    /** Page queries belong to the retained Settings layout. */
    | { clearOnOpen: false; queryState: SettingsPageSearchQuery }
)>) {
    const router = useRouter();
    const railQuery = React.useState('');
    const queryState = options.clearOnOpen ? railQuery : options.queryState;
    const [query, setQuery] = queryState;
    const normalizedQuery = query.trim();
    const { clearOnOpen, tag } = options;
    const openRoute = React.useCallback((route: string) => {
        const outcome = runGuardedNavigation(() => {
            if (clearOnOpen) setQuery('');
            const destination = clearOnOpen ? route
                : `${route}${route.includes('?') ? '&' : '?'}${SETTINGS_SEARCH_RETURN_QUERY_PARAM}=1`;
            router.navigate(destination as never);
        });
        if (outcome !== true) {
            fireAndForget(outcome, { tag });
        }
    }, [clearOnOpen, router, setQuery, tag]);
    return { query, setQuery, normalizedQuery, active: normalizedQuery.length > 0, openRoute };
}

// Query results are rebuilt as matches change; retained rows depend only on their visible facts.
// Keep callbacks and the rail icon inside the row so an unchanged match does not redraw.
const SettingsSearchResultRow = React.memo(function SettingsSearchResultRow(props: Readonly<{
    title: string;
    subtitle?: string;
    route: string;
    testID: string;
    presentation: 'rail' | 'page';
    onOpen: (route: string) => void;
}>) {
    const { theme } = useUnistyles();
    const { onOpen, route } = props;
    const onPress = React.useCallback(() => onOpen(route), [onOpen, route]);
    if (props.presentation === 'page') {
        return <WorkspaceDestinationRow href={route}><Item
            rowRole="item"
            testID={props.testID} title={props.title} subtitle={props.subtitle} onPress={onPress}
        /></WorkspaceDestinationRow>;
    }
    return <CollectionNavigationRow
        rowRole="item"
        href={route} testID={props.testID} title={props.title} subtitle={props.subtitle}
        icon={<Icon name="magnifying-glass" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
        selected={false} onPress={onPress}
    />;
});

/**
 * The results of a settings query: the pages it names first, then individual settings with their
 * path. `rail` renders compact rows under small labels for the desktop rail; `page` renders page
 * sections for the phone Settings page.
 */
export const SettingsSearchResults = React.memo(function SettingsSearchResults(props: Readonly<{
    results: readonly SettingsPageSearchResult[];
    tree: readonly ResolvedSettingsPageNode[];
    presentation: 'rail' | 'page';
    /** Rows are `<prefix>.<pageId>` and `<prefix>.setting.<anchor>`. */
    testIDPrefix: string;
    emptyTestID: string;
    onOpen: (route: string) => void;
}>) {
    const pages = React.useMemo(() => indexSettingsSearchPages(props.tree), [props.tree]);
    const { pageRows, settingRows } = React.useMemo(
        () => buildSettingsSearchRows(props.results, pages),
        [pages, props.results],
    );
    const { testIDPrefix } = props;
    const rowTestID = React.useCallback((row: SettingsSearchRow) => row.kind === 'setting'
        ? `${testIDPrefix}.setting.${row.id}`
        : `${testIDPrefix}.${row.id}`, [testIDPrefix]);
    const groups = [
        { id: 'pages', title: t('settingsSearch.pagesTitle'), rows: pageRows },
        { id: 'settings', title: t('settingsSearch.settingsTitle'), rows: settingRows },
    ].filter((group) => group.rows.length > 0);

    if (groups.length === 0) {
        const empty = (
            <Item
                testID={props.emptyTestID}
                title={t('common.noMatches')}
                mode="info"
                density={props.presentation === 'rail' ? 'compact' : undefined}
                showChevron={false}
                style={props.presentation === 'rail' ? resolveHappierCollectionListRowPadding(0) : undefined}
            />
        );
        return props.presentation === 'rail' ? empty : <ItemGroup>{empty}</ItemGroup>;
    }

    // Broad queries match most of the catalog; the recycler mounts only the rows in view.
    // Labels and rows are one flat list, so the scroll owner windows both.
    return <WindowedSearchRows groups={groups} presentation={props.presentation}
        testIDPrefix={props.testIDPrefix} rowTestID={rowTestID} onOpen={props.onOpen} />;
});

type SearchListEntry =
    | Readonly<{ key: string; kind: 'label'; id: string; title: string; first: boolean }>
    | Readonly<{ key: string; kind: 'row'; row: SettingsSearchRow }>;

const WindowedSearchRows = React.memo(function WindowedSearchRows(props: Readonly<{
    groups: ReadonlyArray<Readonly<{ id: string; title: string; rows: readonly SettingsSearchRow[] }>>;
    presentation: 'rail' | 'page';
    testIDPrefix: string;
    rowTestID: (row: SettingsSearchRow) => string;
    onOpen: (route: string) => void;
}>) {
    const { groups, presentation, rowTestID, onOpen } = props;
    // Every keystroke answers with fresh result objects. An entry whose shown facts are unchanged keeps
    // its identity, so the recycler redraws only the cells whose result changed, not every mounted cell.
    const entriesRef = React.useRef<readonly SearchListEntry[] | null>(null);
    const entries = React.useMemo<readonly SearchListEntry[]>(() => {
        const next = retainKeyedRows(entriesRef.current, groups.flatMap((group, index) => [
            { key: `label:${group.id}`, kind: 'label' as const, id: group.id, title: group.title, first: index === 0 },
            ...group.rows.map((row) => ({ key: searchRowKey(row), kind: 'row' as const, row })),
        ]), entryKey, { freeze: false });
        entriesRef.current = next;
        return next;
    }, [groups]);
    const renderEntry = React.useCallback(({ item }: Readonly<{ item: SearchListEntry }>) => {
        if (item.kind === 'label') {
            return <View testID={`${props.testIDPrefix}.group.${item.id}`}><CollectionListGroupLabel title={item.title} first={item.first} /></View>;
        }
        return <SettingsSearchResultRow route={item.row.route} testID={rowTestID(item.row)} title={item.row.title}
            subtitle={item.row.subtitle} presentation={presentation} onOpen={onOpen} />;
    }, [onOpen, presentation, rowTestID, props.testIDPrefix]);
    return (
        <ListPresentationProvider value={presentation === 'page' ? 'page' : 'grouped'}>
            <VirtualizedList testID={`${props.testIDPrefix}.list`} data={entries} keyExtractor={entryKey}
                renderItem={renderEntry} style={listStyle} getItemType={entryType} />
        </ListPresentationProvider>
    );
});

const listStyle = { flex: 1, minHeight: 0 } as const;
const entryKey = (entry: SearchListEntry) => entry.key;
const searchRowKey = (row: SettingsSearchRow) => row.kind === 'setting' ? `setting:${row.id}` : row.id;
const entryType = (entry: SearchListEntry) => entry.kind;

/**
 * Results for a live query. The search index (and the route params its hrefs resolve against) is built
 * here, so the surrounding rail or page neither follows route params nor indexes Settings while idle.
 */
export const SettingsQueryResults = React.memo(function SettingsQueryResults(props: Readonly<{
    query: string;
    presentation: 'rail' | 'page';
    testIDPrefix: string;
    emptyTestID: string;
    onOpen: (route: string) => void;
}>) {
    const catalog = useResolvedSettingsPageCatalog();
    const { search } = catalog;
    const results = React.useMemo(() => search(props.query), [props.query, search]);
    return <SettingsSearchResults presentation={props.presentation} results={results} tree={catalog.tree}
        testIDPrefix={props.testIDPrefix} emptyTestID={props.emptyTestID} onOpen={props.onOpen} />;
});
