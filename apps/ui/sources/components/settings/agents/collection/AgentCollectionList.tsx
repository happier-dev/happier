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
import { formatAcpBackendCommand, useAcpCatalogBackends } from '@/components/settings/acpCatalog/AcpCatalogSettingsSections';
import { CustomAcpAgentMark } from '@/components/settings/acpCatalog/CustomAcpAgentMark';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { useMachineAgent, useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { useMachineAgentRowActions } from '@/components/machines/agents/useMachineAgentRowActions';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildAgentCollection, resolveSelectedAgentCollectionId, type AgentCollectionRow } from './agentCollectionModel';
import { recordAgentCollectionVisit } from './agentCollectionVisit';
import { customAcpDraftTitle } from './customAcpDraftTitle';
import { useAgentAdministrationCatalog, type AgentAdministrationCatalog } from './useAgentAdministrationCatalog';
import { useAgentAuthoringEntry } from '../authoring/useAgentAuthoringEntry';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark, useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;

function readParam(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

/** One status line; quiet (none) when the machine has not said anything about the agent yet. */
function resolveRowStatusLabel(row: AgentCollectionRow): string | undefined {
    switch (row.status) {
        case 'notInstalled': return t('machineAgents.notInstalled');
        case 'disabled': return t('settingsAgents.stateDisabled');
        case 'needsSignIn': return t('machineAgents.needsSignIn');
        case 'ready':
        case 'updateAvailable':
            return t('settingsAgents.collection.ready');
        case 'installing': return t('machineAgents.installing');
        case 'failed': return t('agentInstallJob.failed');
        case 'unsupported': return t('machineAgents.unsupportedOs');
        case 'checking': return t('machineAgents.checking');
        case 'unknown': return undefined;
    }
}

/**
 * Opens a custom ACP agent (or a new draft) in the collection. Beside the rail it replaces the shown
 * detail, like selecting an agent; where the list is the page it pushes the editor.
 */
function openCustomAcpEditor(router: ReturnType<typeof useRouter>, backendId: string | null, replace: boolean) {
    const href = createCustomAcpAgentSettingsRoute(backendId) as never;
    const result = runGuardedNavigation(() => (replace ? router.replace(href) : router.push(href)));
    if (result !== true) fireAndForget(result, { tag: 'AgentCollectionList.openCustomAcpEditor' });
}

/**
 * The collection's "+": define an ACP agent yourself, or ask an agent to add one (as an ACP backend
 * or a plugin) in a New Session. Asking needs a machine to run on; without one the entry says so
 * and opens machine setup instead of doing nothing.
 */
export const AddAgentMenu = React.memo(function AddAgentMenu(props: Readonly<{
    catalog: AgentAdministrationCatalog;
}>) {
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const besideDetail = useHappierCollectionLayout()?.mode === 'split'
        && pathname.startsWith('/settings/agents/');
    const [open, setOpen] = React.useState(false);
    const authoring = useAgentAuthoringEntry(props.catalog);
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => [
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
                if (id === 'acp') {
                    openCustomAcpEditor(router, null, besideDetail);
                    return;
                }
                if (id === 'askAgent') authoring.open('addAgent');
            }}
            placement="bottom"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={320}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
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
    const inventory = useMachineAgents({
        serverId: executionTarget?.serverId ?? null,
        machineId: executionTarget?.machine.id ?? null,
        load: options?.detect !== false,
    });
    const collection = React.useMemo(() => buildAgentCollection({
        entries: agentEntries,
        agents: inventory.agents,
        query,
    }), [agentEntries, inventory.agents, query]);
    return {
        collection,
        detecting: executionTarget !== null && inventory.status === 'loading',
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
    const { executionTarget, projectionCurrent, agentEntries, machineOnline, machineLabel } = props.catalog;
    const machine = executionTarget?.machine ?? null;
    const serverId = executionTarget?.serverId ?? null;
    const { backends: customBackends } = useAcpCatalogBackends();

    const [query, setQuery] = React.useState('');
    const { collection } = useAgentCollection(props.catalog, query);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleCustomBackends = React.useMemo(() => customBackends.filter((backend) => !normalizedQuery
        || (backend.title || backend.name).toLocaleLowerCase().includes(normalizedQuery)), [customBackends, normalizedQuery]);

    const onDetailRoute = pathname.startsWith('/settings/agents/');
    const customAcpRoute = resolveCustomAcpAgentRoute(pathname);
    const selectedAgentId = onDetailRoute
        ? resolveSelectedAgentCollectionId(agentEntries, {
            agentId: readParam(params.agentId),
            pluginId: readParam(params.pluginId),
        })
        : null;
    React.useEffect(() => {
        if (selectedAgentId) recordAgentCollectionVisit(selectedAgentId);
    }, [selectedAgentId]);

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
        const dimmed = row.status === 'notInstalled';
        const statusLabel = resolveRowStatusLabel(row);
        return (
            <Item
                key={row.entry.agentId}
                testID={`settings-agents-collection.row.${row.entry.agentId}`}
                title={row.entry.title}
                titleAccessory={row.entry.channel === 'experimental' ? (
                    <StatusPill variant="neutral" label={t('settingsAgents.collection.beta')} hideDot />
                ) : undefined}
                subtitle={statusLabel}
                subtitleLeading={row.trouble ? (
                    <View testID={`settings-agents-collection.trouble.${row.entry.agentId}`} style={collectionListStyles.troubleDot} />
                ) : undefined}
                icon={(
                    <HappierCollectionListMark dimmed={dimmed}>
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
                titleStyle={dimmed ? collectionListStyles.dimmedTitle : undefined}
                selected={rail ? row.entry.agentId === selectedAgentId : undefined}
                density={rail ? 'compact' : undefined}
                showChevron={!rail && row.status !== 'notInstalled'}
                rightElement={row.status === 'notInstalled' && row.entry.cli ? (
                    <AgentRowInstallAction
                        entry={row.entry}
                        machineId={machineOnline ? machine?.id ?? null : null}
                        serverId={serverId}
                        machineName={machineLabel ?? ''}
                        onOpen={() => openAgent(row.entry)}
                    />
                ) : undefined}
                pressableStyle={rail ? collectionListStyles.row : undefined}
                onPress={() => openAgent(row.entry)}
            />
        );
    };
    const renderCustomRow = (backend: (typeof customBackends)[number]) => (
        <Item
            key={backend.id}
            testID={`settings-agents-collection.custom.${backend.id}`}
            title={backend.title || backend.name}
            subtitle={formatAcpBackendCommand(backend.command, backend.args)}
            icon={<CustomAcpAgentMark />}
            selected={rail ? customAcpRoute?.kind === 'saved' && customAcpRoute.backendId === backend.id : undefined}
            density={rail ? 'compact' : undefined}
            showChevron={!rail}
            pressableStyle={rail ? collectionListStyles.row : undefined}
            onPress={() => openCustomAcpEditor(router, backend.id, rail && onDetailRoute)}
        />
    );

    // With no machine chosen nothing was detected anywhere, so the list carries no "On <machine>" claim.
    const onMachineTitle = machineLabel
        ? t('settingsAgents.collection.onMachine', { machine: machineLabel })
        : undefined;
    const total = collection.total + customBackends.length;
    const searchable = total > SEARCH_THRESHOLD;
    const noMatches = total > 0
        && collection.onMachine.length === 0
        && collection.available.length === 0
        && visibleCustomBackends.length === 0;
    const emptyRow = collection.total === 0 && customBackends.length === 0 ? (
        <Item
            title={t('settingsAgents.notAvailable')}
            subtitle={t('settingsAgents.footer')}
            mode="info"
        />
    ) : noMatches ? (
        <Item title={t('settingsAgents.collection.noMatches')} mode="info" />
    ) : null;
    if (!rail) {
        return (
            <>
                {searchable ? (
                    <CompactSearchField
                        testID="settings-agents-collection.search"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('settingsAgents.collection.searchPlaceholder')}
                        placement="page"
                    />
                ) : null}
                {emptyRow ? <ItemGroup>{emptyRow}</ItemGroup> : null}
                {collection.onMachine.length > 0 ? (
                    <ItemGroup title={onMachineTitle}>{collection.onMachine.map(renderRow)}</ItemGroup>
                ) : null}
                {collection.available.length > 0 ? (
                    <ItemGroup title={t('settingsAgents.collection.availableToInstall')}>
                        {collection.available.map(renderRow)}
                    </ItemGroup>
                ) : null}
                {visibleCustomBackends.length > 0 ? (
                    <ItemGroup title={t('settingsAgents.collection.customAgents')}>
                        {visibleCustomBackends.map(renderCustomRow)}
                    </ItemGroup>
                ) : null}
            </>
        );
    }

    return (
        <CollectionList
            testID="settings-agents-collection.rail"
            title={t('settingsAgents.title')}
            count={total}
            headerAction={<AddAgentMenu catalog={props.catalog} />}
            search={searchable ? {
                testID: 'settings-agents-collection.search',
                value: query,
                onChangeText: setQuery,
                placeholder: t('settingsAgents.collection.searchPlaceholder'),
            } : null}
        >
            {customAcpRoute?.kind === 'draft' ? <CustomAcpDraftRow /> : null}
            {emptyRow}
            {collection.onMachine.length > 0 && onMachineTitle ? (
                <CollectionListGroupLabel title={onMachineTitle} count={collection.onMachine.length} first />
            ) : null}
            {collection.onMachine.map(renderRow)}
            {collection.available.length > 0 ? (
                <CollectionListGroupLabel
                    title={t('settingsAgents.collection.availableToInstall')}
                    count={collection.available.length}
                    first={collection.onMachine.length === 0}
                />
            ) : null}
            {collection.available.map(renderRow)}
            {visibleCustomBackends.length > 0 ? (
                <CollectionListGroupLabel
                    title={t('settingsAgents.collection.customAgents')}
                    count={visibleCustomBackends.length}
                    first={collection.onMachine.length === 0 && collection.available.length === 0}
                />
            ) : null}
            {visibleCustomBackends.map(renderCustomRow)}
        </CollectionList>
    );
});

/** The new ACP agent being written in the detail pane, titled as it is typed. */
const CustomAcpDraftRow = React.memo(function CustomAcpDraftRow() {
    return (
        <CollectionDraftRow
            testID="settings-agents-collection.customDraft"
            titles={customAcpDraftTitle}
            placeholder={t('settingsAgents.customAcp.newTitle')}
            mark={<CustomAcpAgentMark />}
        />
    );
});

/** The rail beside an agent's detail; it reads the managed machine's catalog itself. */
export const AgentCollectionRail = React.memo(function AgentCollectionRail() {
    const catalog = useAgentAdministrationCatalog();
    return <AgentCollectionList variant="rail" catalog={catalog} />;
});

/**
 * A not-installed agent's compact Install: starts the daemon install job (the one row-action owner) and
 * opens the agent's detail, whose form shows the job's steps.
 */
const AgentRowInstallAction = React.memo(function AgentRowInstallAction(props: Readonly<{
    entry: ResolvedAgentCatalogEntry;
    machineId: string | null;
    serverId: string | null;
    machineName: string;
    onOpen: () => void;
}>) {
    const agent = useMachineAgent({ serverId: props.serverId, machineId: props.machineId, agentId: props.entry.agentId, load: false });
    const runAction = useMachineAgentRowActions({
        serverId: props.serverId ?? '',
        machineId: props.machineId ?? '',
        machineName: props.machineName,
        onOpenForm: props.onOpen,
    });
    const available = Boolean(agent && props.machineId && props.serverId && agent.install.available);
    return (
        <RoundButton
            testID={`settings-agents-collection.install.${props.entry.agentId}`}
            size="small"
            display="secondary"
            title={t('settingsAgents.collection.install')}
            accessibilityLabel={t('machineAgents.installAgent', { agent: props.entry.title })}
            disabled={!available}
            loading={agent?.state === 'installing'}
            onPress={() => { if (agent) runAction(agent, agent.install.available ? { kind: 'install' } : { kind: 'signIn' }); }}
        />
    );
});
