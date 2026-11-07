import * as React from 'react';
import { View } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import {
    createAgentSettingsRoute,
    createCustomAcpAgentSettingsRoute,
    resolveCustomAcpAgentRoute,
} from '@/agents/catalog/agentSettingsRoutes';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { formatAcpBackendCommand, useAcpCatalogBackends } from '@/components/settings/acpCatalog/useAcpCatalogBackends';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { useHeldMachineAgentSummary } from '@/agents/machineAgents/useHeldMachineAgentSummary';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { resolveConfiguredAcpAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { openAgentAddModal, type OpenAgentAddModalParams } from '../add/agentAddModalConfig';
import { buildAgentCollection, filterAgentCollectionByQuery, isCommandAgentDefinition, resolveSelectedAgentCollectionId, type AgentCollectionRow } from './agentCollectionModel';
import { CollectionIndexRow } from '@/components/ui/lists/collection/CollectionIndexRow';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { resolveAgentsMachineCandidateAvailability, type AgentAdministrationCatalog } from './useAgentAdministrationCatalog';
import { AgentAdministrationCatalogBoundary, useBoundaryAgentAdministrationCatalog } from './AgentAdministrationCatalogBoundary';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SettingsCollectionPage } from '@/components/settings/shell/SettingsCollectionPage';
import { useAgentAuthoringEntry } from '../authoring/useAgentAuthoringEntry';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { CollectionStatusLine, type CollectionRowStatus } from '@/components/ui/lists/collection/CollectionStatusGlyph';
import { HappierCollectionListMark, useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { useSettingsColumnFilter } from '@/components/settings/shell/useSettingsColumnFilter';
import type { SettingsCollectionRowFacts } from '@/components/settings/shell/settingsCollectionAdapter';
import { agentColumnAdapter, agentColumnFacts, resolveAgentColumnContext } from './agentColumnAdapter';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;

function readParam(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

/** One status line; quiet (none) when the machine has not said anything about the agent yet. */
/** The row's state that must be said (P8 slots): a verified sign-in trouble, a failure, a waiting update. */
function resolveRowStatus(row: AgentCollectionRow, label: string | undefined): Readonly<{ status: CollectionRowStatus; label: string }> | null {
    const status: CollectionRowStatus | null = row.trouble ? 'signIn'
        : row.status === 'failed' ? 'failed'
            : row.status === 'updateAvailable' ? 'update'
                : null;
    if (!status) return null;
    return { status, label: status === 'update' ? t('capabilities.status.update') : label ?? t('machineAgents.needsSignIn') };
}

function resolveRowStatusLabel(row: AgentCollectionRow): string | undefined {
    switch (row.status) {
        case 'notInstalled': return t('machineAgents.notInstalled');
        case 'disabled': return t('settingsAgents.stateDisabled');
        case 'needsSignIn': return t('machineAgents.needsSignIn');
        case 'ready':
        case 'updateAvailable': {
            if (row.signIn?.status === 'signedIn') {
                const via = row.signIn.via;
                if (via?.kind === 'connected') return t('machineAgents.signedInWith', { label: via.profileLabel ?? via.title });
                if (via?.accountLabel) return t('machineAgents.signedInAs', { label: via.accountLabel });
                return t('machineAgents.signedInHere');
            }
            return t('settingsAgents.collection.ready');
        }
        case 'installing': return t('machineAgents.installing');
        case 'failed': return t('agentInstallJob.failed');
        case 'unsupported': return t('machineAgents.unsupported');
        case 'checking': return t('machineAgents.checking');
        case 'installsOnFirstUse': return t('capabilities.agentAdd.adding.firstUse');
        case 'unknown': return undefined;
    }
}

/**
 * Opens a custom ACP agent (or a new draft) in the collection. Beside the rail it replaces the shown
 * detail, like selecting an agent; where the list is the page it pushes the editor.
 */
export function openCustomAcpEditor(router: ReturnType<typeof useRouter>, backendId: string | null, replace: boolean) {
    const href = createCustomAcpAgentSettingsRoute(backendId) as never;
    const result = runGuardedNavigation(() => (replace ? router.replace(href) : router.push(href)));
    if (result !== true) fireAndForget(result, { tag: 'AgentCollectionList.openCustomAcpEditor' });
}

/** Wide enough for the longest entry description on one line (a menu row clamps its description to one). */
const ADD_AGENT_MENU_MAX_WIDTH_PX = 384;

/**
 * The collection's "+": define an ACP agent yourself, or ask an agent to add one (as an ACP backend
 * or a plugin) in a New Session. Asking needs a machine to run on; without one the entry says so
 * and opens machine setup instead of doing nothing.
 */
/**
 * Browse agents in the one Add modal; a choice opens its agent (or the command/definition editor), replacing the shown
 * detail beside the rail and pushing elsewhere.
 */
export function useOpenAgentBrowse() {
    const callbacks = useAgentAddContinuations();
    return React.useCallback((seed?: Readonly<Pick<OpenAgentAddModalParams, 'initialModeKey' | 'sourceId' | 'query' | 'initialSelection'>>) =>
        openAgentAddModal({ ...seed, ...callbacks }), [callbacks]);
}

/** The same native continuation routes for the Add dialog and a Store listing. */
export function useAgentAddContinuations(): Pick<OpenAgentAddModalParams, 'onCommand' | 'onOpenDefinition' | 'onOpenAgent'> {
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const besideDetail = useHappierCollectionLayout()?.mode === 'split'
        && pathname.startsWith('/settings/agents/');
    return React.useMemo<Pick<OpenAgentAddModalParams, 'onCommand' | 'onOpenDefinition' | 'onOpenAgent'>>(() => ({
        onCommand: () => openCustomAcpEditor(router, null, besideDetail),
        onOpenDefinition: (definitionId) => openCustomAcpEditor(router, definitionId, besideDetail),
        onOpenAgent: (entry) => {
            const href = createAgentSettingsRoute(entry) as never;
            const result = runGuardedNavigation(() => (besideDetail ? router.replace(href) : router.push(href)));
            if (result !== true) fireAndForget(result, { tag: 'AddAgentMenu.openAgent' });
        },
    }), [besideDetail, router]);
}

export const AddAgentMenu = React.memo(function AddAgentMenu(props: Readonly<{
    catalog: AgentAdministrationCatalog;
    /** A home's header carries the page's one primary action ("Add an agent"); a column keeps its quiet "+". */
    trigger?: 'icon' | 'primary';
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const besideDetail = useHappierCollectionLayout()?.mode === 'split'
        && pathname.startsWith('/settings/agents/');
    const openBrowse = useOpenAgentBrowse();
    const [open, setOpen] = React.useState(false);
    const authoring = useAgentAuthoringEntry(props.catalog);
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => [
        {
            id: 'browse',
            title: t('capabilities.agentAdd.browse'),
            subtitle: t('capabilities.agentAdd.browseDescription'),
        },
        {
            id: 'acp',
            title: t('settingsAgents.collection.addAcpAgent'),
            subtitle: t('settingsAgents.collection.addAcpAgentDescription'),
        },
        {
            id: 'askAgent',
            title: t('settingsAgents.collection.askAgentToAdd'),
            subtitle: authoring.available
                ? t('settingsAgents.collection.askAgentToAddDescription')
                : t('settingsAgents.authoring.needsMachine'),
        },
    ], [authoring.available]);
    return (
        <DropdownMenu
            testID="settings-agents-collection.addMenu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={(id) => {
                setOpen(false);
                if (id === 'browse') {
                    openBrowse();
                    return;
                }
                if (id === 'acp') {
                    openCustomAcpEditor(router, null, besideDetail);
                    return;
                }
                if (id === 'askAgent') authoring.open('addAgent');
            }}
            placement="bottom"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={ADD_AGENT_MENU_MAX_WIDTH_PX}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => props.trigger === 'primary' ? (
                <RoundButton
                    testID="settings-agents-home.add"
                    size="normal"
                    title={t('settingsAgents.collection.addAgent')}
                    leading={<Icon name="plus" size={16} color={theme.colors.button.primary.tint} />}
                    onPress={toggle}
                />
            ) : (
                <IconButton
                    testID="settings-agents-collection.addCustomAcp"
                    iconName="plus"
                    accessibilityLabel={t('settingsAgents.collection.addAgent')}
                    tooltip={t('settingsAgents.collection.addAgent')}
                    variant="plain"
                    onPress={toggle}
                />
            )}
        />
    );
});

/**
 * The collection grouped by the selected machine's agent inventory (the one owner, `useMachineAgents`):
 * installed, needs sign-in, not installed, can't run. `detect: false` reads cached and last-known facts
 * without asking the machine (a summary elsewhere, e.g. Home's attention).
 */
export function useAgentCollection(
    catalog: AgentAdministrationCatalog,
    query: string,
    options?: Readonly<{ detect?: boolean }>,
) {
    const { executionTarget, agentEntries } = catalog;
    const { backends } = useAcpCatalogBackends();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    // Registry agents are agents: each definition gets its catalog presentation (title, enablement) once.
    const definitions = React.useMemo(() => backends
        .filter((definition) => !isCommandAgentDefinition(definition))
        .map((definition) => ({ definition, entry: resolveConfiguredAcpAgentCatalogProjection(definition, { enabledAgentIds: [], backendEnabledByTargetKey }) })),
    [backendEnabledByTargetKey, backends]);
    const inventory = useMachineAgents({
        serverId: executionTarget?.serverId ?? null,
        machineId: executionTarget?.machine.id ?? null,
        load: options?.detect !== false,
    });
    const allCollection = React.useMemo(() => buildAgentCollection({
        entries: agentEntries,
        agents: inventory.agents,
        definitions,
        query: '',
    }), [agentEntries, definitions, inventory.agents]);
    const collection = React.useMemo(() => filterAgentCollectionByQuery(allCollection, query), [allCollection, query]);
    return {
        collection,
        allCollection,
        // The Machine's inventory is not known yet (never read, or its first read is under way): no agent can be placed
        // as on the Machine or available, so a surface holds the space of what will arrive.
        detecting: executionTarget !== null && (inventory.status === 'loading' || inventory.status === 'idle') && inventory.agents.length === 0,
        refreshDetection: inventory.refresh,
    } as const;
}

/**
 * The Agents collection: agents found on the selected machine, the ones available to install, then
 * the custom ACP agents this Account defines. `rail` is the narrow list beside an agent's detail;
 * `page` is the same list as page sections where no rail is showing. Selection comes from the route.
 */
export const AgentCollectionList = React.memo(function AgentCollectionList(props: Readonly<{
    variant: 'rail' | 'page';
    catalog: AgentAdministrationCatalog;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const params = useGlobalSearchParams<{ agentId?: string | string[]; pluginId?: string | string[] }>();
    const { executionTarget, projectionCurrent, agentEntries, machineLabel } = props.catalog;
    const machine = executionTarget?.machine ?? null;
    const serverId = executionTarget?.serverId ?? null;
    const activeAccountScope = useActiveServerAccountScope();
    const summaryServerId = props.catalog.projectionScope?.serverId
        ?? props.catalog.targetSelection.selectedTarget?.serverIdentityId
        ?? activeAccountScope?.serverId ?? null;
    const { binding: summaryBinding } = useServerCredentialAccountScopeBinding(summaryServerId);
    const summaryScope = summaryBinding?.isCurrent() ? summaryBinding.scope : null;
    const summaryMachineIds = React.useMemo(() => props.catalog.targetSelection.pickerRows
        .filter(candidate => summaryScope && areServerProfileIdentifiersEquivalent(candidate.serverId, summaryScope.serverId)
            && (candidate.candidate.availability === 'online' || candidate.candidate.availability === 'offline'
                || candidate.candidate.availability === 'unknown'))
        .map(candidate => candidate.machine.id), [props.catalog.targetSelection.pickerRows, summaryScope?.serverId]);
    const previousPublishedInventories = React.useRef<ReadonlyMap<string, MachinePublishedMetadataV1['agentInventory']>>(new Map());
    const summaryPublishedInventories = React.useMemo(() => {
        const next = new Map(props.catalog.targetSelection.pickerRows
            .filter(candidate => summaryScope && areServerProfileIdentifiersEquivalent(candidate.serverId, summaryScope.serverId))
            .map(candidate => [candidate.machine.id, candidate.machine.metadata?.agentInventory] as const));
        const previous = previousPublishedInventories.current;
        if (previous.size === next.size && [...next].every(([id, inventory]) => previous.has(id) && previous.get(id) === inventory)) return previous;
        previousPublishedInventories.current = next;
        return next;
    }, [props.catalog.targetSelection.pickerRows, summaryScope?.serverId]);
    const { backends: customBackends, brandMarks } = useAcpCatalogBackends();

    const [query, setQuery] = React.useState('');
    const { collection: queriedCollection, allCollection } = useAgentCollection(props.catalog, query);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const commandBackends = React.useMemo(() => customBackends.filter(isCommandAgentDefinition), [customBackends]);
    const projectionMachineId = props.catalog.projectionScope?.machineId ?? null;
    const filterFacts = React.useMemo<readonly SettingsCollectionRowFacts<'status' | 'machine'>[]>(() => [
        ...[...allCollection.onMachine, ...allCollection.available].map((row) => agentColumnFacts(row, {
            context: resolveRowStatusLabel(row) ?? null, machineId: projectionMachineId,
        })),
        // Account-defined commands have no observed Machine readiness; do not invent it for filtering.
        ...commandBackends.map((backend) => ({ key: `definition:${backend.id}`, title: backend.title || backend.name,
            context: null, status: null, fields: { status: null, machine: null } })),
    ], [allCollection, commandBackends, projectionMachineId]);
    const filterFields = React.useMemo(() => {
        const statusLabels = new Map<string, string>([...allCollection.onMachine, ...allCollection.available].flatMap((row) => {
            const label = resolveRowStatusLabel(row);
            return label ? [[row.status, label] as const] : [];
        }));
        return {
            status: { label: t('sessionsList.filtersStatus'), valueLabel: (value: string) => statusLabels.get(value) ?? t('common.unavailable') },
            machine: { label: t('sessionsList.filtersMachine'), valueLabel: (value: string) => value === projectionMachineId && machineLabel ? machineLabel : t('common.unavailable') },
        };
    }, [allCollection, machineLabel, projectionMachineId]);
    const columnFilter = useSettingsColumnFilter({
        column: 'agents',
        search: { value: query, set: setQuery },
        testIDPrefix: 'settings-agents-collection',
        adapter: agentColumnAdapter,
        fields: filterFields,
        facts: filterFacts,
    });
    const matchesFilter = columnFilter.matches;
    const collection = React.useMemo(() => ({ ...queriedCollection,
        onMachine: queriedCollection.onMachine.filter((row) => matchesFilter(row.key)),
        available: queriedCollection.available.filter((row) => matchesFilter(row.key)),
    }), [matchesFilter, queriedCollection]);
    const visibleCustomBackends = React.useMemo(() => commandBackends.filter((backend) => matchesFilter(`definition:${backend.id}`)
        && (!normalizedQuery || (backend.title || backend.name).toLocaleLowerCase().includes(normalizedQuery))), [commandBackends, matchesFilter, normalizedQuery]);

    const onDetailRoute = pathname.startsWith('/settings/agents/');
    const customAcpRoute = resolveCustomAcpAgentRoute(pathname);
    const selectedAgentId = onDetailRoute
        ? resolveSelectedAgentCollectionId(agentEntries, {
            agentId: readParam(params.agentId),
            pluginId: readParam(params.pluginId),
        })
        : null;
    const openAgent = React.useCallback((entry: ResolvedAgentCatalogEntry) => {
        const href = createAgentSettingsRoute(entry) as never;
        // Beside a detail, switching agents replaces the shown detail instead of stacking history.
        const result = runGuardedNavigation(() => (props.variant === 'rail' && onDetailRoute
            ? router.replace(href)
            : router.push(href)));
        if (result !== true) fireAndForget(result, { tag: 'AgentCollectionList.openAgent' });
    }, [onDetailRoute, props.variant, router]);

    const rail = props.variant === 'rail';
    const renderRow = (row: AgentCollectionRow) => {
        const dimmed = row.status === 'notInstalled' || row.status === 'installsOnFirstUse';
        const rowStatusLabel = resolveRowStatusLabel(row);
        // The status (P8): amber only for an actionable, current sign-in; a failure in rose; an update neutral. Its word
        // leads line 2 on every width (S10 X4), so the held context after it never repeats "Needs sign-in".
        // Under "Available to install" the group already says it, so those rows stay one calm line.
        const rowStatus = resolveRowStatus(row, rowStatusLabel);
        const statusLabel = (rowStatus && row.status === 'needsSignIn') || (row.status === 'notInstalled' && machineLabel)
            ? undefined : rowStatusLabel;
        const subtitleOf = (context: string | undefined): React.ReactNode => rowStatus === null ? context : (
            <CollectionStatusLine status={rowStatus.status} label={rowStatus.label}
                description={context === rowStatus.label ? null : context}
                testID={`settings-agents-collection.trouble.${row.key}`} />
        );
        const definition = row.definition;
        const renderItem = (context: string | undefined) => {
            if (definition) {
                const selectedDefinition = customAcpRoute?.kind === 'saved' && customAcpRoute.backendId === definition.id;
                return (
                    <Item
                        rowRole="catalogRow"
                        key={row.key}
                        testID={`settings-agents-collection.definition.${definition.id}`}
                        title={row.entry.title}
                        subtitle={subtitleOf(context)}
                        icon={<HappierCollectionListMark dimmed={dimmed}><HappierBrandMark
                            brand={brandMarks?.[definition.id] ?? { displayName: row.entry.title }} pixelSize={20} externallyLabelled
                        /></HappierCollectionListMark>}
                        dimmed={dimmed}
                        selected={rail ? selectedDefinition : undefined}
                        density="compact"
                        showChevron={false}
                        pressableStyle={collectionListStyles.row}
                        onPress={() => openCustomAcpEditor(router, definition.id, rail && onDetailRoute)}
                    />
                );
            }
            return (
                <Item
                    rowRole="catalogRow"
                    key={row.key}
                    testID={`settings-agents-collection.row.${row.entry.agentId}`}
                    title={row.entry.title}
                    subtitle={subtitleOf(context)}
                    icon={(
                        <HappierCollectionListMark rowRole="catalogRow" dimmed={dimmed}>
                            <AgentCatalogIdentityIcon
                                entry={row.entry}
                                machineId={machine?.id ?? null}
                                serverId={serverId}
                                current={projectionCurrent}
                                color={theme.colors.text.secondary}
                                size={20}
                            />
                        </HappierCollectionListMark>
                    )}
                    dimmed={dimmed}
                    selected={rail ? row.entry.agentId === selectedAgentId : undefined}
                    density="compact"
                    showChevron={false}
                    // Available agents are a calm list (lab sfcols:agents): the row opens the agent, whose
                    // Machines section offers Install or the vendor's setup guide for each machine.
                    pressableStyle={collectionListStyles.row}
                    onPress={() => openAgent(row.entry)}
                />
            );
        };
        return (
            <AgentHeldInventoryContext key={row.key} scope={summaryScope} machineIds={summaryMachineIds}
                publishedByMachineId={summaryPublishedInventories} agentId={row.entry.agentId}
                definitionId={row.definition?.id} fallback={statusLabel}>
                {renderItem}
            </AgentHeldInventoryContext>
        );
    };
    const renderCustomRow = (backend: (typeof customBackends)[number]) => (
        <Item
            rowRole="catalogRow"
            key={backend.id}
            testID={`settings-agents-collection.custom.${backend.id}`}
            title={backend.title || backend.name}
            subtitle={formatAcpBackendCommand(backend.launch.kind === 'command'
                ? backend.launch.command
                : backend.launch.kind === 'archive' ? backend.launch.version : `${backend.launch.package}@${backend.launch.version}`,
            backend.launch.args)}
            icon={<HappierCollectionListMark><HappierBrandMark brand={brandMarks?.[backend.id] ?? { displayName: backend.title || backend.name }} pixelSize={20} externallyLabelled /></HappierCollectionListMark>}
            selected={rail ? customAcpRoute?.kind === 'saved' && customAcpRoute.backendId === backend.id : undefined}
            density="compact"
            showChevron={false}
            pressableStyle={collectionListStyles.row}
            onPress={() => openCustomAcpEditor(router, backend.id, rail && onDetailRoute)}
        />
    );

    // With no machine chosen nothing was detected anywhere, so the list makes no "On <machine>"
    // claim: it groups by what the Account has enabled, which needs no machine.
    const groups: ReadonlyArray<Readonly<{ key: string; title: string; rows: readonly AgentCollectionRow[] }>> = machineLabel
        ? [
            { key: 'onMachine', title: t('settingsAgents.collection.onMachine', { machine: machineLabel }), rows: collection.onMachine },
            { key: 'available', title: t('settingsAgents.collection.availableToInstall'), rows: collection.available },
        ]
        : [
            { key: 'enabled', title: t('settingsAgents.collection.enabledGroup'), rows: collection.onMachine.filter((row) => row.status !== 'disabled') },
            {
                key: 'more',
                title: t('settingsAgents.collection.moreAgents'),
                rows: [...collection.onMachine.filter((row) => row.status === 'disabled'), ...collection.available],
            },
        ];
    const firstGroupKey = groups.find((group) => group.rows.length > 0)?.key ?? null;
    const total = collection.total + commandBackends.length;
    const searchable = total > SEARCH_THRESHOLD || query.length > 0;
    const noMatches = total > 0
        && collection.onMachine.length === 0
        && collection.available.length === 0
        && visibleCustomBackends.length === 0;
    const emptyRow = collection.total === 0 && commandBackends.length === 0 ? (
        <Item
            title={t('settingsAgents.notAvailable')}
            subtitle={t('settingsAgents.footer')}
            mode="info"
        />
    ) : noMatches ? (
        <Item title={t('settingsAgents.collection.noMatches')} mode="info" />
    ) : null;
    const search = searchable ? {
        testID: 'settings-agents-collection.search',
        value: query,
        onChangeText: setQuery,
        placeholder: t('settingsAgents.collection.searchPlaceholder'),
        trailing: columnFilter.filterButton,
        anchorRef: columnFilter.searchAnchorRef,
    } : null;
    // The column's rows, one list for the rail and for a phone's page.
    const rows = (
        <>
            {customAcpRoute?.kind === 'draft' ? <CustomAcpDraftRow /> : null}
            {emptyRow}
            {groups.map((group) => group.rows.length > 0 ? (
                <React.Fragment key={group.key}>
                    <CollectionListGroupLabel title={group.title} count={group.rows.length} first={group.key === firstGroupKey} />
                    {group.rows.map(renderRow)}
                </React.Fragment>
            ) : null)}
            {visibleCustomBackends.length > 0 ? (
                <CollectionListGroupLabel
                    title={t('settingsAgents.collection.customAgents')}
                    count={visibleCustomBackends.length}
                    first={collection.onMachine.length === 0 && collection.available.length === 0}
                />
            ) : null}
            {visibleCustomBackends.map(renderCustomRow)}
            {columnFilter.editorOverlay}
        </>
    );
    if (rail) {
        return (
            <CollectionList
                testID="settings-agents-collection.rail"
                title={t('settingsAgents.title')}
                count={total}
                headerAction={<>{total > 0 && !searchable ? columnFilter.filterButton : null}<AddAgentMenu catalog={props.catalog} /></>}
                strip={columnFilter.tokenRow}
                search={search}
            >
                <CollectionIndexRow testID="settings-agents-collection.all"
                    selected={!onDetailRoute}
                    onPress={() => {
                        const result = runGuardedNavigation(() => router.replace('/(app)/settings/agents' as never));
                        if (result !== true) fireAndForget(result, { tag: 'AgentCollectionList.openHome' });
                    }} />
                {rows}
            </CollectionList>
        );
    }
    // A phone's page is the rail's own list under a large title with its count (lab sfcols:agentsP). The
    // machine chip and "+" are the page's own controls, so Add's menu never nests in the navigation overflow.
    return (
        <SettingsCollectionPage
            testID="settings-agents-collection.page"
            headerTestID="settings.agents.index.header"
            count={total}
            actions={(
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <MachineAdministrationTargetSelector
                        selection={props.catalog.targetSelection}
                        presentation="chip"
                        resolveCandidateAvailability={resolveAgentsMachineCandidateAvailability}
                        testIDPrefix="settings.agents.administration.target"
                    />
                    {total > 0 && !searchable ? columnFilter.filterButton : null}
                    <AddAgentMenu catalog={props.catalog} />
                </View>
            )}
        >
            <CollectionList testID="settings-agents-collection.page.list" strip={columnFilter.tokenRow} search={search} scrollContent={rows} />
        </SettingsCollectionPage>
    );
});

/** The row reads only installation/version facts already held for this Home and Account. */
const AgentHeldInventoryContext = React.memo(function AgentHeldInventoryContext(props: Readonly<{
    scope: ServerAccountScope | null;
    machineIds: readonly string[];
    agentId: string;
    definitionId?: string;
    publishedByMachineId: ReadonlyMap<string, MachinePublishedMetadataV1['agentInventory']>;
    fallback?: string;
    children: (context: string | undefined) => React.ReactElement;
}>) {
    const summary = useHeldMachineAgentSummary(props);
    return props.children(resolveAgentColumnContext(summary, props.fallback ?? null) ?? undefined);
});

/** The new ACP agent being written in the detail pane, titled as it is typed. */
const CustomAcpDraftRow = React.memo(function CustomAcpDraftRow() {
    const customAcpDraftTitle = useCollectionDraftTitle();
    const title = customAcpDraftTitle.useTitle();
    return (
        <CollectionDraftRow
            rowRole="item"
            testID="settings-agents-collection.customDraft"
            titles={customAcpDraftTitle}
            placeholder={t('settingsAgents.customAcp.newTitle')}
            mark={<HappierCollectionListMark><HappierBrandMark brand={{ displayName: title || t('settingsAgents.customAcp.newTitle') }} pixelSize={20} externallyLabelled /></HappierCollectionListMark>}
        />
    );
});

/** The rail beside an agent's detail; it reads the managed machine's catalog itself. */
export const AgentCollectionRail = React.memo(function AgentCollectionRail() {
    return <AgentAdministrationCatalogBoundary><AgentCollectionRailBody /></AgentAdministrationCatalogBoundary>;
});

const AgentCollectionRailBody = React.memo(function AgentCollectionRailBody() {
    const catalog = useBoundaryAgentAdministrationCatalog();
    return <AgentCollectionList variant="rail" catalog={catalog} />;
});
