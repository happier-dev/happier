import * as React from 'react';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { SettingsCollectionPage } from '@/components/settings/shell/SettingsCollectionPage';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useMcpServersSettings } from '../useMcpServersSettings';
import { useFoundMcpServersCount } from '../found/useFoundMcpServersCount';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { mcpServerAttentionStatus } from '../status/mcpServerStatus';
import { useMcpServerMachineFacts } from '../status/useMcpServerMachineFacts';
import { mcpSignInFact } from '../signIn/mcpSignInGrantView';
import { useMcpSignInViewOf } from '../signIn/useMcpSignInViewOf';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { shortWhereItsOn } from '@/components/capabilities/where/whereItsOnPresentation';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { useOpenMcpAddModal } from '../add/useOpenMcpAddModal';
import { usePluginMcpServerItems } from './usePluginMcpServerItems';
import type { McpPluginItemMetadataV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import {
    buildMcpServerCollection,
    MCP_COLLECTION_ROUTE,
    MCP_NEW_SERVER_ROUTE,
    MCP_FOUND_ROUTE,
    mcpServerRoute,
    type McpServerCollectionRow,
} from './mcpServerCollectionModel';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, CollectionSkeletonRows, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import { AskHappierMark } from '@/components/sessions/bots/AskHappierOfferCard';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { CollectionIndexRow } from '@/components/ui/lists/collection/CollectionIndexRow';
import { CollectionViewSwitch } from '@/components/ui/lists/collection/CollectionViewSwitch';
import { setPreviewedMcpServer } from '../home/mcpServerPreview';
import { McpServersEmpty, McpServersHomeSummary } from '../home/McpServersHome';
import { mcpColumnAdapter, mcpColumnFacts } from './mcpColumnAdapter';
import { useSettingsColumnFilter } from '@/components/settings/shell/useSettingsColumnFilter';
import type { SettingsCollectionRowFacts } from '@/components/settings/shell/settingsCollectionAdapter';
import { capabilityStatusLabels } from '@/components/capabilities/status/capabilityStatusPresentation';
import type { McpServerRuleV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;
/** Placeholder rows while the first read is pending (the list column is reserved from first paint). */
const SKELETON_ROWS = 4;

/**
 * The MCP servers collection: what other agents run on your machines (Found) first, the Account's
 * servers In use and Off, then Happier's own built-in server, which Settings → Actions governs. `rail` is the list beside the
 * selected detail; `page` is the same list as page sections where no rail shows (phones).
 * Selection comes from the route.
 */
export const McpServerCollection = React.memo(function McpServerCollection(props: Readonly<{
    variant: 'rail' | 'page';
    selectedServerId?: string | null;
}>) {
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const rail = props.variant === 'rail';
    const navigate = React.useCallback((href: string) => {
        // Beside a detail, choosing another item replaces the shown detail instead of stacking history.
        const result = runGuardedNavigation(() => (rail ? router.replace(href as never) : router.push(href as never)));
        if (result !== true) fireAndForget(result, { tag: 'McpServerCollection.navigate' });
    }, [rail, router]);
    const { settings, scope, snapshot } = useMcpServersSettings();
    const [query, setQuery] = React.useState('');
    const previousRows = React.useRef<readonly McpServerCollectionRow[]>([]);
    const rows = React.useMemo(() => buildMcpServerCollection(settings, query, previousRows.current, snapshot.brandMarks), [query, settings, snapshot.brandMarks]);
    React.useEffect(() => { previousRows.current = rows; }, [rows]);
    const inUse = React.useMemo(() => rows.filter((row) => !row.unbound), [rows]);
    const off = React.useMemo(() => rows.filter((row) => row.unbound), [rows]);
    const { machines: reachMachines, placeMachines, agentIds } = useReachMachines();
    const foundMachineIds = React.useMemo(() => reachMachines.map(machine => machine.machineId), [reachMachines]);
    const foundCount = useFoundMcpServersCount(foundMachineIds, scope);
    const { names } = useWhereItsOnNames({ agentIds, machines: placeMachines });
    const savedSecretCatalog = useSavedSecretCatalog({ scope });
    const signInOf = useMcpSignInViewOf(settings, scope);
    const machineFactsOf = useMcpServerMachineFacts(reachMachines);
    const statuses = React.useMemo(() => new Map(rows.map(row => [row.server.id, row.unbound ? null : mcpServerAttentionStatus({
        entry: row.server, signIn: mcpSignInFact(signInOf(row.server.id)), savedSecretCatalog,
        // The column says the status word only (lab n:home): the fix is the home's Needs you row (wide and phone) or the
        // detail's banner, never a third copy on the row.
        ...machineFactsOf(row),
    })])), [rows, signInOf, savedSecretCatalog, machineFactsOf]);
    const pluginItems = usePluginMcpServerItems();
    const plugins = React.useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        return pluginItems
            .filter((item) => !normalizedQuery || (item.title ?? item.name).toLocaleLowerCase().includes(normalizedQuery))
            .slice()
            .sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
    }, [pluginItems, query]);
    const total = settings.servers.length;
    // The first read has not answered: the list keeps its column with placeholder rows, never "Built in" alone.
    const loading = snapshot.status === 'loading' && total === 0;

    // Status and Runs on (P8): held row facts only, read through the MCP adapter's registry.
    const statusOf = React.useCallback((row: McpServerCollectionRow) => statuses.get(row.server.id) ?? null, [statuses]);
    const facts = React.useMemo<readonly SettingsCollectionRowFacts<'status' | 'runsOn'>[]>(() => [
        ...rows.map((row) => {
            const status = statusOf(row);
            return mcpColumnFacts(row, { machineIds: enabledMachineIds(row.bindings), statuses: status ? [status] : [] });
        }),
        ...pluginItems.map((item) => ({ key: item.id, title: item.title ?? item.name, context: null, status: null,
            fields: { status: [], runsOn: enabledMachineIds(settings.bindings.filter((binding) => binding.serverId === item.id)) } })),
    ], [pluginItems, rows, settings.bindings, statusOf]);
    const filterFields = React.useMemo(() => {
        const labels = new Map<string, string>([['off', capabilityStatusLabels.status('off', undefined)]]);
        for (const row of rows) {
            const status = statusOf(row);
            if (status && status.kind !== 'ready') labels.set(status.kind, capabilityStatusLabels.status(status.kind, status.machineName));
        }
        return {
            status: { label: t('sessionsList.filtersStatus'), valueLabel: (kind: string) => labels.get(kind) ?? kind },
            runsOn: { label: t('sessionsList.filtersRunsOn'), valueLabel: names.machineName },
        };
    }, [names, rows, statusOf]);
    const filter = useSettingsColumnFilter({
        column: 'mcp',
        search: { value: query, set: setQuery },
        testIDPrefix: rail ? 'settings.mcpServers.rail' : 'settings.mcpServers.page',
        adapter: mcpColumnAdapter,
        fields: filterFields,
        facts,
    });
    const matchesFilter = filter.matches;
    const shownInUse = React.useMemo(() => inUse.filter((row) => matchesFilter(row.server.id)), [matchesFilter, inUse]);
    const shownOff = React.useMemo(() => off.filter((row) => matchesFilter(row.server.id)), [matchesFilter, off]);
    const shownPlugins = React.useMemo(() => plugins.filter((item) => matchesFilter(item.id)), [matchesFilter, plugins]);

    const renderServerRow = (row: McpServerCollectionRow) => {
        const selected = rail && row.server.id === props.selectedServerId;
        const toolCount = row.server.toolsSnapshot?.tools.length;
        const tokens = row.server.toolsSnapshot?.tools.reduce((sum, tool) => sum + tool.tokens, 0);
        const status = statusOf(row);
        return (
            <CapabilityRow
                key={row.server.id}
                testID={`mcp.server.card.${row.server.id}`}
                title={row.title}
                description={row.server.description ?? null}
                whereSummary={shortWhereItsOn(row.bindings, names)}
                mark={<HappierBrandMark brand={row.brandMark ?? { displayName: row.title }} pixelSize={20} externallyLabelled />}
                facts={{
                    presentation: 'row',
                    ...(toolCount !== undefined ? { cost: { toolCount, ...(tokens ? { tokensPerTurn: tokens } : {}) } } : {}),
                    extra: [row.server.transport === 'stdio' ? t('capabilities.mcp.local') : t('capabilities.mcp.remote')],
                }}
                status={status}
                count={toolCount ?? null}
                density="rail"
                selected={rail ? selected : undefined}
                onPress={() => navigate(mcpServerRoute(row.server.id))}
                // Beside the homepage, pointing at a server lights its tether there (lab hm-A2h).
                {...(rail ? { onPreviewChange: (active: boolean) => setPreviewedMcpServer(active ? row.server.id : null) } : {})}
            />
        );
    };

    // A plugin's server: read-only here (no Configuration, no Remove); Where and Tools still apply.
    const renderPluginRow = (item: McpPluginItemMetadataV1) => (
        <CapabilityRow
            key={item.id}
            testID={`mcp.server.plugin.${item.id}`}
            title={item.title ?? item.name}
            description={item.description ?? null}
            whereSummary={shortWhereItsOn(settings.bindings.filter((binding) => binding.serverId === item.id), names)}
            mark={<HappierBrandMark brand={{ displayName: item.title ?? item.name }} pixelSize={20} externallyLabelled />}
            facts={{
                presentation: 'row',
                source: { kind: 'plugin', pluginName: item.source.pluginName },
                extra: [item.transport === 'stdio' ? t('capabilities.mcp.local') : t('capabilities.mcp.remote')],
            }}
            status={null}
            density="rail"
            selected={rail ? item.id === props.selectedServerId : undefined}
            onPress={() => navigate(mcpServerRoute(item.id))}
        />
    );

    // Built in: Happier's own server is governed by Settings → Actions (T4), never by this page.
    const builtInRow = (
        <Item
            key="happier"
            testID="settings.mcpServers.builtIn.happier"
            title={t('capabilities.mcp.builtInHappier')}
            subtitle={t('capabilities.mcp.builtInHappierDescription')}
            icon={<HappierCollectionListMark><AskHappierMark size={20} /></HappierCollectionListMark>}
            detail={t('capabilities.mcp.builtInActions')}
            density="compact"
            showChevron
            pressableStyle={collectionListStyles.row}
            onPress={() => {
                const result = runGuardedNavigation(() => router.push(SETTINGS_ROUTES.actions as never));
                if (result !== true) fireAndForget(result, { tag: 'McpServerCollection.builtIn' });
            }}
        />
    );

    const openAdd = useOpenMcpAddModal();
    const addMenu = (
        <IconButton
            testID="settings.mcpServers.addServer"
            iconName="plus"
            accessibilityLabel={t('mcpSettings.add')}
            tooltip={t('mcpSettings.add')}
            variant="plain"
            onPress={() => openAdd()}
        />
    );
    const searchable = total > SEARCH_THRESHOLD || query.length > 0;
    const search = {
        testID: 'settings.mcpServers.search',
        value: query,
        onChangeText: setQuery,
        placeholder: t('mcpSettings.searchPlaceholder'),
    };
    const draftOpen = pathname === MCP_NEW_SERVER_ROUTE;

    // The column's rows, one list for the rail and for a phone's page: the servers you added In use and Off,
    // plugins' own, then Happier's built-in server, which a condition on the servers leaves out.
    const groups = (
        <>
            {draftOpen ? <McpServerDraftRow /> : null}
            {loading && !draftOpen ? <CollectionSkeletonRows count={SKELETON_ROWS} rowRole="catalogRow" /> : null}
            {total === 0 && !loading && !draftOpen ? (
                rail ? (
                    <EmptyState
                        testID="settings.mcpServers.empty"
                        layout="line"
                        title={t('settings.mcpServersEmptyTitle')}
                    />
                ) : <McpServersEmpty />
            ) : null}
            {shownInUse.length > 0 ? <CollectionListGroupLabel title={t('capabilities.mcp.inUse')} count={shownInUse.length} /> : null}
            {shownInUse.map(renderServerRow)}
            {shownOff.length > 0 ? <CollectionListGroupLabel title={t('capabilities.mcp.off')} count={shownOff.length} /> : null}
            {shownOff.map(renderServerRow)}
            {shownPlugins.length > 0 ? <CollectionListGroupLabel title={t('capabilities.mcp.fromPlugins')} count={shownPlugins.length} /> : null}
            {shownPlugins.map(renderPluginRow)}
            {filter.active || loading ? null : <CollectionListGroupLabel title={t('capabilities.mcp.builtIn')} />}
            {filter.active || loading ? null : builtInRow}
        </>
    );
    const list = (
        <CollectionList
            testID={rail ? 'settings.mcpServers.rail' : 'settings.mcpServers.page.list'}
            // The rail names itself; a phone's page has its page header above the list.
            {...(rail ? {
                title: t('settings.mcpServers'),
                count: total,
                // The filter button sits in the search well once the list has a search field (lab `sfcols:mcpFilter`).
                headerAction: total > 0 && !searchable ? <>{filter.filterButton}{addMenu}</> : addMenu,
            } : {})}
            strip={filter.tokenRow}
            search={searchable ? { ...search, trailing: filter.filterButton, anchorRef: filter.searchAnchorRef } : null}
            // Two views of one column (P8): the servers you added, and what other agents already run.
            filters={rail || total > 0 ? {
                targetCount: Math.max(total, 1),
                content: (
                    <CollectionViewSwitch
                        view={pathname === MCP_FOUND_ROUTE ? 'found' : 'all'}
                        foundCount={foundCount}
                        foundLabel={t('capabilities.mcp.foundOnMachines')}
                        onChange={(view) => navigate(view === 'found' ? MCP_FOUND_ROUTE : MCP_COLLECTION_ROUTE)}
                        testIDPrefix={rail ? 'settings.mcpServers.rail.view' : 'settings.mcpServers.page.view'}
                    />
                ),
            } : null}
            // The page scrolls as one (header, search, switch and rows); the rail's list owns its scroll.
            {...(rail ? { children: <>
                <CollectionIndexRow testID="settings.mcpServers.rail.overview"
                    selected={pathname === MCP_COLLECTION_ROUTE}
                    onPress={() => navigate(MCP_COLLECTION_ROUTE)} />
                {groups}{filter.editorOverlay}
            </> } : { scrollContent: <>{groups}{filter.editorOverlay}</> })}
        />
    );

    if (rail) return list;

    return (
        // A phone's page is the rail's own list under a large title with its count and Add (lab sfcols:mcpP).
        <SettingsCollectionPage
            testID="settings.mcpServers.page"
            headerTestID="settings.mcpServers.header"
            count={total}
            actions={total > 0 ? <>{searchable ? null : filter.filterButton}{addMenu}</> : loading ? addMenu : undefined}
        >
            {total > 0 || loading ? <McpServersHomeSummary /> : null}
            {list}
        </SettingsCollectionPage>
    );
});

/** Held Machine/folder rules name their Machine; broad/Project rules do not supply a complete enumerable census here. */
function enabledMachineIds(bindings: readonly McpServerRuleV1[]): readonly string[] | null {
    const ids = new Set<string>();
    for (const binding of bindings) {
        if (!binding.enabled) continue;
        if (binding.target.t !== 'machine' && binding.target.t !== 'workspace') return null;
        ids.add(binding.target.machineId);
    }
    return [...ids];
}

/** The server being added in the detail pane, at the top of the rail, titled as it is typed. */
const McpServerDraftRow = React.memo(function McpServerDraftRow() {
    const mcpServerDraftTitle = useCollectionDraftTitle();
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            rowRole="item"
            testID="settings.mcpServers.draft"
            titles={mcpServerDraftTitle}
            placeholder={t('mcpSettings.newServer')}
            mark={<HappierCollectionListMark><Icon name="terminal" size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
        />
    );
});
