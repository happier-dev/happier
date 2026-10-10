import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Item } from '@/components/ui/lists/Item';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
    CollectionListGroupLabel,
    CollectionNavigationRow,
} from '@/components/ui/lists/collection/CollectionList';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveHappierCollectionListRowPadding } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { ResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode, SettingsPageSearchResult } from '@/components/settings/catalog/types';

import { buildSettingsSearchRows, indexSettingsSearchPages, type SettingsSearchRow } from './settingsSearchRows';
import { SETTINGS_SEARCH_RETURN_QUERY_PARAM } from '@/components/settings/navigation/settingsRouteRegistry';
import type { SettingsPageSearchQuery } from './SettingsPageSearchContext';

/**
 * Settings search, shared by the desktop rail and the phone Settings page: one query, one result
 * list from the catalog owner, one way to open a result (guarded against unsaved work).
 */
export function useSettingsSearch(catalog: ResolvedSettingsPageCatalog, options: Readonly<{
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
    const { search } = catalog;
    const results = React.useMemo(
        () => (normalizedQuery ? search(normalizedQuery) : []),
        [normalizedQuery, search],
    );
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
    return { query, setQuery, active: normalizedQuery.length > 0, results, openRoute };
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
            testID={props.testID} title={props.title} subtitle={props.subtitle} onPress={onPress}
        /></WorkspaceDestinationRow>;
    }
    return <CollectionNavigationRow
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
    const rowTestID = (row: SettingsSearchRow) => row.kind === 'setting'
        ? `${props.testIDPrefix}.setting.${row.id}`
        : `${props.testIDPrefix}.${row.id}`;
    const rowKey = (row: SettingsSearchRow) => row.kind === 'setting' ? `setting:${row.id}` : row.id;
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

    if (props.presentation === 'page') {
        return (
            <>
                {groups.map((group) => (
                    <View key={group.id} testID={`${props.testIDPrefix}.group.${group.id}`}>
                        <ItemGroup title={group.title}>
                            {group.rows.map((row) => (
                                <SettingsSearchResultRow key={rowKey(row)}
                                    testID={rowTestID(row)}
                                    title={row.title}
                                    subtitle={row.subtitle}
                                    route={row.route}
                                    presentation={props.presentation}
                                    onOpen={props.onOpen}
                                />
                            ))}
                        </ItemGroup>
                    </View>
                ))}
            </>
        );
    }

    return (
        <>
            {groups.map((group, index) => (
                <View key={group.id} testID={`${props.testIDPrefix}.group.${group.id}`}>
                    <CollectionListGroupLabel title={group.title} first={index === 0} />
                    {group.rows.map((row) => (
                        <SettingsSearchResultRow
                            key={rowKey(row)}
                            route={row.route}
                            testID={rowTestID(row)}
                            title={row.title}
                            subtitle={row.subtitle}
                            presentation={props.presentation}
                            onOpen={props.onOpen}
                        />
                    ))}
                </View>
            ))}
        </>
    );
});
