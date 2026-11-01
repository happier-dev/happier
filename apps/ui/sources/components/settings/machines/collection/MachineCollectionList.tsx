import * as React from 'react';
import type { Pressable } from 'react-native';
import { useMachineCollection } from './useMachineCollection';
import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useMachinesSettingsViewModel, type MachinesSettingsViewModel } from '../machinesSettingsViewModel';
import { useActiveActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { readManagedInstallationPrompt } from '../managed/managedCreationPresentation';
import { MachinePoolsSection } from '../sections/MachinePoolsSection';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import {
    MACHINES_ADD_ROUTE,
    MACHINES_THIS_COMPUTER_ROUTE,
    isMachineCollectionRowSelected,
    machineCollectionHref,
    managedMachineConsentKey,
    machineCollectionRowKey,
    machinesIndexHref,
    partitionMachineCollectionRailRows,
    resolveSelectedMachineCollectionKey,
    type MachineCollectionRow,
    type MachineCollectionSection,
    type MachinePresetCollectionSection,
} from './machineCollectionModel';
import { recordMachineCollectionVisit, readLastVisitedMachine } from './machineCollectionVisit';
import { useMachineAddOptions, type MachineAddOption } from './useMachineAddOptions';
import { useMachineAddDraftRow } from '@/components/machines/add/useMachineAddFlow';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, CollectionSkeletonRows, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { CollectionIndexRow } from '@/components/ui/lists/collection/CollectionIndexRow';
import { useRevealSelectedRow } from '@/components/ui/lists/collection/useRevealSelectedRow';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { MachinePresetQueryState } from '../managed/useMachinePresets';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedMachineReadApprovalNotice } from '../managed/ManagedMachineReadApprovalNotice';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { MANAGED_PROVISIONER_MARK_SIZE, ManagedPresetMark } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { useMachineResourceFleetAttention } from '@/sync/domains/machines/resources/useMachineResourceFleetAttention';
import { MachineListRowSummary } from '@/components/machines/summary/MachineListRowSummary';
import { useMachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;

/** The directory batches known owners; an owner beyond its current page uses the same exact Team reader as detail. */
function MachinePresetTeamCollectionRow(props: Readonly<{
    serverId: string; teamId: string; knownName?: string; render: (audience: string) => React.ReactElement;
}>) {
    const binding = useTeamBinding(props.serverId, props.knownName ? '' : props.teamId);
    const state = binding.kind === 'bound' ? binding.state : null;
    const name = props.knownName ?? (state?.kind === 'ready' && state.team.capabilities.viewTeam ? state.team.name
        : state?.kind === 'unavailable' ? t('common.unavailable') : t('common.loading'));
    return props.render(name);
}

function readParam(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

/** Presence first, as every machine row reads (K1 picker anatomy), then the row's own facts. */
function statusLine(row: MachineCollectionRow, withHost: boolean): string {
    return [row.presence, row.reason, row.ownership, withHost ? row.host : null, withHost && !row.ownership ? row.platformLabel : null].filter(Boolean).join(' · ');
}

function openHref(router: ReturnType<typeof useRouter>, href: string, replace: boolean, tag: string) {
    const result = runGuardedNavigation(() => (replace ? router.replace(href as never) : router.push(href as never)));
    if (result !== true) fireAndForget(result, { tag });
}

/**
 * The Machines collection's "+": the ways this device can add to it (`useMachineAddOptions`). Setup
 * opens the setup wizard; a new pool opens its draft in the collection.
 */
export const AddMachineMenu = React.memo(function AddMachineMenu(props: Readonly<{
    options: readonly MachineAddOption[];
    /** Beside a detail, an option inside the collection replaces the open detail. */
    replaceInCollection: boolean;
}>) {
    const router = useRouter();
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => props.options.map((option) => ({
        id: option.id,
        title: option.title,
        subtitle: option.subtitle,
    })), [props.options]);
    if (props.options.length === 0) return null;
    return (
        <DropdownMenu
            testID="settings.machines.addMenu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={(id) => {
                setOpen(false);
                const option = props.options.find((candidate) => candidate.id === id);
                if (!option) return;
                openHref(router, option.href, option.inCollection && props.replaceInCollection, 'AddMachineMenu.select');
            }}
            placement="bottom"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={320}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <IconButton
                    testID="settings.machines.addMenu.trigger"
                    iconName="plus"
                    accessibilityLabel={t('settings.addMachine')}
                    tooltip={t('settings.addMachine')}
                    variant="plain"
                    onPress={toggle}
                />
            )}
        />
    );
});

/**
 * The ways to add a machine as action tiles: the Machines page when there is nothing to list yet,
 * and the Add a machine page.
 */
export const MachineAddOptionTiles = React.memo(function MachineAddOptionTiles(props: Readonly<{
    options: readonly MachineAddOption[];
    testIdPrefix: string;
}>) {
    const router = useRouter();
    if (props.options.length === 0) return null;
    return (
        <SelectionTiles
            variant="action"
            accessibilityLabel={t('settings.addMachine')}
            testIdPrefix={props.testIdPrefix}
            options={props.options.map((option) => ({
                id: option.id,
                title: option.title,
                subtitle: option.subtitle,
                icon: option.icon,
            }))}
            onPress={(id) => {
                const option = props.options.find((candidate) => candidate.id === id);
                if (option) openHref(router, option.href, false, 'MachineAddOptionTiles.press');
            }}
        />
    );
});

/**
 * The Machines collection: this computer (desktop app), the machines of each Home the app shows, then
 * their machine pools. `rail` is the narrow list beside the open detail; `page` is the same list as
 * page sections where no rail shows. Selection comes from the route.
 */
export const MachineCollectionList = React.memo(function MachineCollectionList(props: Readonly<{
    /**
     * `configuration`: only the collection's configuration (defaults, this computer, pools, recipes) and its
     * read notices, under All machines where no list stands beside it; All machines lists the machines.
     */
    variant: 'rail' | 'page' | 'configuration';
    viewModel: MachinesSettingsViewModel;
    addOptions: readonly MachineAddOption[];
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const params = useGlobalSearchParams<{ serverId?: string | string[] }>();
    const { viewModel, addOptions } = props;
    const isDesktop = isDesktopHost();
    const rail = props.variant === 'rail';
    // Rows stay in the door the list stands in; configuration rows always open in Settings (MPG-2).
    const door = useMachinesDoor();
    const doorRoot = machinesIndexHref(door);
    // "2 need a look" on the All machines row (lab `R`): machines that need you or are worth a look, from the fleet projection.
    const fleetAttention = useMachineResourceFleetAttention();
    const fleetLookCount = React.useMemo(() => new Set([
        ...fleetAttention.needsYou.map(key => JSON.stringify([key.serverId ?? null, key.machineId])),
        ...fleetAttention.look.map(entry => entry.machineKey),
    ]).size, [fleetAttention]);
    const onDetailRoute = pathname === doorRoot || pathname.startsWith(`${doorRoot}/`);
    const replaceConfiguration = rail && onDetailRoute && door === 'settings';
    const selectedKey = rail ? resolveSelectedMachineCollectionKey(pathname, { serverId: readParam(params.serverId) }) : null;

    const [query, setQuery] = React.useState(() => readLastVisitedMachine()?.query ?? '');
    const unfiltered = useMachineCollection({
        groups: viewModel.visibleMachineGroups,
        groupedByHome: viewModel.showMachinesGroupedByServer,
        managedByServerId: viewModel.managedByServerId,
        managedFirstAnswerPending: viewModel.managedFirstAnswerPending,
        presetsByServerId: viewModel.presetsByServerId,
    });
    const total = unfiltered.count;
    const searchable = total > SEARCH_THRESHOLD;
    const teamServerIds = React.useMemo(() => Object.entries(viewModel.presetsByServerId ?? {})
        .filter(([, presets]) => presets.some(preset => preset.owner.kind === 'team')).map(([serverId]) => serverId), [viewModel.presetsByServerId]);
    const teams = useTeamsDirectory({ serverIds: teamServerIds, enabled: teamServerIds.length > 0, archived: 'all' });
    const teamNamesByServerId = React.useMemo(() => {
        const names: Record<string, Record<string, string>> = {};
        for (const row of [...teams.rows, ...teams.archivedRows]) (names[row.address.serverId] ??= {})[row.team.id] = row.team.name;
        return names;
    }, [teams.rows, teams.archivedRows]);
    // A creation waiting on the user's consent says so on its row; its page asks the question.
    const activeOperations = useActiveActionOperations();
    const awaitingConsentKey = activeOperations.flatMap(operation => {
        const prompt = readManagedInstallationPrompt(operation);
        const reference = operation.snapshot.domainRef;
        return prompt && reference?.kind === 'managedMachine' ? [managedMachineConsentKey(operation.serverId, reference.id)] : [];
    }).sort().join('\n');
    const awaitingConsent = React.useMemo(() => new Set(awaitingConsentKey ? awaitingConsentKey.split('\n') : []), [awaitingConsentKey]);
    const collection = useMachineCollection({
        awaitingConsent,
        groups: viewModel.visibleMachineGroups,
        groupedByHome: viewModel.showMachinesGroupedByServer,
        managedFirstAnswerPending: viewModel.managedFirstAnswerPending,
        query: searchable ? query : '',
        managedByServerId: viewModel.managedByServerId,
        presetsByServerId: viewModel.presetsByServerId,
        teamNamesByServerId,
    });

    // The column is an open surface: its online machines' summaries stay live while it shows (one batched demand).
    const demandKeys = React.useMemo(() => rail ? collection.sections.flatMap(section => section.rows)
        .flatMap(row => row.online && row.kind === 'machine' ? [{ serverId: row.serverId, machineId: row.machineId }] : []) : [], [collection.sections, rail]);
    useMachineResourceLiveDemand(demandKeys, { detail: 'summary', enabled: rail });

    React.useEffect(() => {
        const selected = collection.sections.flatMap(section => section.rows).find(row => isMachineCollectionRowSelected(selectedKey, row));
        if (selected) recordMachineCollectionVisit({ ...selected, query });
    }, [selectedKey, collection, query]);

    const openMachine = (row: MachineCollectionRow) => {
        recordMachineCollectionVisit({ ...row, query });
        // Beside a detail, switching machines replaces the shown detail instead of stacking history.
        openHref(router, machineCollectionHref(row, door), rail && onDetailRoute, 'MachineCollectionList.openMachine');
    };

    // A long fleet opens on its selected machine, not at the top of the column.
    const selectedPresent = rail && collection.sections.some(section => section.rows.some(row => isMachineCollectionRowSelected(selectedKey, row)));
    const selectedRowRef = useRevealSelectedRow<React.ComponentRef<typeof Pressable>>(selectedKey, selectedPresent);

    const renderMachineRow = (row: MachineCollectionRow) => rail ? (
        // Beside a page (lab `R`): one line — the mark, the name, and on the right its summary or one quiet word.
        <Item
            key={machineCollectionRowKey(row)}
            testID={row.kind === 'managed' ? `settings.machines.managed.${row.serverId}.${row.managedId}` : `settings.machines.row.${row.serverId}.${row.machineId}`}
            // One line: a long name shortens; what tells two same-named machines apart stays whole.
            title={row.titleParts.name}
            titleQualifier={row.titleParts.hint}
            titleLines={1}
            accessibilityLabel={[row.title, statusLine(row, true)].filter(Boolean).join(', ')}
            // At the rail's narrowest the name wins: the summary steps aside before it shortens the name.
            rightElementYields
            rightElement={(
                <MachineListRowSummary
                    testID={`settings.machines.row.${row.serverId}.${row.kind === 'managed' ? row.managedId : row.machineId}.summary`}
                    serverId={row.serverId}
                    machineId={row.kind === 'machine' ? row.machineId : row.enrolledMachineId ?? null}
                    online={row.online}
                    quietWord={row.reason ?? (row.status === 'unknown' ? t('common.unknown') : !row.online && row.kind === 'managed' ? row.presenceWord ?? row.presence : !row.online ? t('machineDetailPage.offline') : row.ownership)}
                />
            )}
            icon={(
                <HappierCollectionListMark>
                    <Icon name="desktop" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={isMachineCollectionRowSelected(selectedKey, row)}
            pressableRef={isMachineCollectionRowSelected(selectedKey, row) ? selectedRowRef : undefined}
            density="compact"
            showChevron={false}
            pressableStyle={collectionListStyles.row}
            onPress={() => openMachine(row)}
        />
    ) : (
        <Item
            key={machineCollectionRowKey(row)}
            testID={row.kind === 'managed' ? `settings.machines.managed.${row.serverId}.${row.managedId}` : `settings.machines.row.${row.serverId}.${row.machineId}`}
            title={row.title}
            subtitle={statusLine(row, !rail)}
            subtitleLeading={row.kind === 'managed' ? undefined : (
                <StatusDot
                    testID={`settings.machines.row.${row.serverId}.${row.machineId}.presence`}
                    color={row.online ? theme.colors.status.connected : theme.colors.status.disconnected}
                />
            )}
            subtitleAccessory={rail || row.kind === 'managed' ? undefined : (
                <MachineCliGlyphs machineId={row.machineId} serverId={row.serverId} isOnline={row.online} />
            )}
            icon={(
                <HappierCollectionListMark>
                    <Icon name="desktop" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={rail ? isMachineCollectionRowSelected(selectedKey, row) : undefined}
            density={rail ? 'compact' : undefined}
            showChevron={!rail}
            pressableStyle={rail ? collectionListStyles.row : undefined}
            onPress={() => openMachine(row)}
        />
    );

    const thisComputerRow = isDesktop ? (
        <Item
            testID="settings.machines.thisComputer"
            title={t('settingsMachines.thisComputerTitle')}
            subtitle={t('settingsMachines.thisComputerRowSubtitle')}
            icon={(
                <HappierCollectionListMark>
                    <Icon name="laptop" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={rail ? selectedKey === 'thisComputer' : undefined}
            density={rail ? 'compact' : undefined}
            showChevron={!rail}
            pressableStyle={rail ? collectionListStyles.row : undefined}
            onPress={() => openHref(router, MACHINES_THIS_COMPUTER_ROUTE, replaceConfiguration, 'MachineCollectionList.thisComputer')}
        />
    ) : null;

    // Machine defaults (D21) open from the top of the list, above the machines they apply to.
    const defaultsRow = (
        <Item
            testID="settings.machines.defaults"
            title={t('managedRetention.defaults')}
            detail={rail ? t('managedRetention.keepIt') : undefined}
            subtitle={rail ? undefined : t('managedRetention.pageDescriptionShort')}
            icon={(
                <HappierCollectionListMark>
                    <Icon name="gear" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={rail ? selectedKey === 'defaults' : undefined}
            density={rail ? 'compact' : undefined}
            showChevron={!rail}
            pressableStyle={rail ? collectionListStyles.row : undefined}
            onPress={() => openHref(router, SETTINGS_ROUTES.machineDefaults, replaceConfiguration, 'MachineCollectionList.defaults')}
        />
    );

    // The collection owns whether names and managed membership have answered.
    const loading = (viewModel.isLoadingMachines && total === 0) || collection.firstAnswerPending;
    const empty = !loading && total === 0;
    // The header counts machines, the same rows its groups count; recipes and retired creations are not machines.
    const machineCount = unfiltered.machineCount;
    const managedReadFailures = readManagedMachineReadFailures(viewModel);
    const renderManagedReadFailures = () => managedReadFailures.map(group => {
        const entry = viewModel.managedInventory?.entries[group.serverId];
        return <SurfaceStateCard key={`managed-read:${group.serverId}`} testID={`settings.machines.managed.read.${group.serverId}`}
            kind={entry?.status === 'denied' ? 'denied' : 'unavailable'} size="line"
            title={entry?.status === 'denied' ? t('managedMachines.detail.readRefused') : t('managedMachines.detail.loadFailed')}
            detail={viewModel.showMachinesGroupedByServer ? group.serverName : undefined}
            diagnosticCode={entry?.errorCode} action={{ label: t('common.retry'), onPress: () => viewModel.managedInventory.refresh() }} />;
    });
    // A Home whose machine list could not be read ends in that fact, not in "no machines" or "Loading…".
    const unreadableGroup = empty
        ? viewModel.visibleMachineGroups.find((group) => group.status === 'error') ?? null
        : null;
    const renderUnreadable = (group: Readonly<{ serverId: string; serverName: string }>, compact: boolean) => (
        <MachineHomeUnreadableRow key={`unreadable:${group.serverId}`} group={group} compact={compact}
            canRetry={group.serverId === viewModel.activeServerId} />
    );
    const noMatches = searchable && query.trim().length > 0 && collection.count === 0;
    // A long list keeps its offline machines under one fold after the ones that can work (real fleets carry
    // dozens of retired or sleeping machines); a short list shows them inline, as the lab's rail does.
    const renderRailSectionRows = (section: MachineCollectionSection) => {
        const { inline, offline } = partitionMachineCollectionRailRows(section.rows, searchable);
        if (offline.length === 0) return inline.map(renderMachineRow);
        return (
            <>
                {inline.map(renderMachineRow)}
                <MachineRowsFold testID={`settings.machines.offline.${section.key}`} title={t('machineDetailPage.offline')}
                    rows={offline} rail selectedKey={selectedKey} query={query} renderRow={renderMachineRow} />
            </>
        );
    };
    const sectionStatusLabel = (section: MachineCollectionSection): string | undefined => {
        switch (section.status) {
            case 'signedOut': return t('server.signedOut');
            case 'loading': return t('status.connecting');
            case 'error': return t('status.error');
            default: return undefined;
        }
    };
    const presetSections = viewModel.presetInventory ? collection.presetSections.map(section => <MachinePresetCollectionSectionView key={section.key}
        section={section} state={viewModel.presetInventory?.statesByServerId[section.serverId]} rail={rail}
        selectedKey={selectedKey} replacing={replaceConfiguration} query={searchable ? query : ''}
        refresh={viewModel.presetInventory.refresh} />) : null;
    const managedReadApprovals = viewModel.visibleMachineGroups.map(group => <ManagedMachineReadApprovalNotice
        key={group.serverId} serverId={group.serverId} entry={viewModel.managedInventory?.entries[group.serverId]}
        testID={`settings.machines.managed.approval.${group.serverId}`} />);

    if (props.variant === 'configuration') {
        return (
            <>
                {renderManagedReadFailures()}
                {managedReadApprovals}
                <ItemGroup>{defaultsRow}{thisComputerRow}</ItemGroup>
                {/* Retired created machines stay recoverable here; All machines lists only the active fleet. */}
                {collection.sections.filter(section => section.archived).map(section => (
                    <ArchivedMachineSection key={section.key} section={section} rail={false}
                        selectedKey={selectedKey} query={searchable ? query : ''} renderRow={renderMachineRow} />
                ))}
                <MachinePoolsSection groups={viewModel.visibleMachineGroups} />
                {presetSections}
            </>
        );
    }

    if (!rail) {
        return (
            <>
                {searchable ? (
                    <CompactSearchField
                        testID="settings.machines.search"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('settingsMachines.searchPlaceholder')}
                        placement="page"
                    />
                ) : null}
                <ItemGroup>{defaultsRow}{thisComputerRow}</ItemGroup>
                {renderManagedReadFailures()}
                {managedReadApprovals}
                {loading ? (
                    <ItemGroup title={t('settings.machines')}>
                        <Item title={t('common.loading')} showChevron={false} mode="info" />
                    </ItemGroup>
                ) : unreadableGroup ? (
                    <ItemGroup title={t('settings.machines')}>
                        {renderUnreadable(unreadableGroup, false)}
                    </ItemGroup>
                ) : empty && managedReadFailures.length > 0 ? null : empty ? (
                    <ItemGroup
                        title={t('settings.addMachine')}
                        description={t('settingsMachines.addPageDescription')}
                        surface="none"
                    >
                        {/* Pools have their own section below, with its own add row. */}
                        <MachineAddOptionTiles options={addOptions.filter((option) => option.id !== 'pool' && option.id !== 'preset')} testIdPrefix="settings.machines.add" />
                    </ItemGroup>
                ) : collection.sections.map((section) => section.archived ? (
                    <ArchivedMachineSection key={section.key} section={section} rail={false}
                        selectedKey={selectedKey} query={searchable ? query : ''} renderRow={renderMachineRow} />
                ) : (
                    <ItemGroup
                        key={section.key}
                        // One Home: the page title already names the list.
                        title={section.title ?? undefined}
                        description={section.title ? [
                            t('settingsMachines.count', { count: section.rows.length }),
                            sectionStatusLabel(section),
                        ].filter(Boolean).join(' · ') : undefined}
                    >
                        {section.rows.length === 0 && !noMatches && section.status === 'error' ? (
                            renderUnreadable({ serverId: section.serverId, serverName: section.title ?? '' }, false)
                        ) : section.rows.length === 0 ? (
                            <Item
                                title={noMatches ? t('common.noMatches') : t('newSession.noMachinesFound')}
                                subtitle={noMatches ? undefined : sectionStatusLabel(section)}
                                showChevron={false}
                                mode="info"
                            />
                        ) : section.rows.map(renderMachineRow)}
                    </ItemGroup>
                ))}
                <MachinePoolsSection groups={viewModel.visibleMachineGroups} />
                {presetSections}
            </>
        );
    }

    return (
        <CollectionList
            testID="settings.machines.rail"
            title={t('settings.machines')}
            count={loading ? null : machineCount}
            headerAction={<AddMachineMenu options={addOptions} replaceInCollection={replaceConfiguration} />}
            search={searchable ? {
                value: query,
                onChangeText: setQuery,
                placeholder: t('settingsMachines.searchPlaceholder'),
                testID: 'settings.machines.rail.search',
            } : null}
        >
            {/* The fleet first (lab `R`): All machines is the index of both doors. */}
            <CollectionIndexRow
                testID="settings.machines.rail.all"
                title={t('allMachines.rowTitle')}
                detail={fleetLookCount > 0 ? t('machineAttention.listNeedLook', { count: fleetLookCount }) : undefined}
                selected={selectedKey === 'allMachines'}
                onPress={() => openHref(router, doorRoot, onDetailRoute, 'MachineCollectionList.allMachines')}
            />
            <MachineDraftRow selected={selectedKey === 'machineDraft'} replace={replaceConfiguration} />
            {selectedKey?.startsWith('poolDraft:') ? <MachinePoolDraftRow /> : null}
            {/* Defaults head the list, above the machines they apply to (lab m-defaults). */}
            {defaultsRow}
            {renderManagedReadFailures()}
            {managedReadApprovals}
            {loading ? (
                <CollectionSkeletonRows count={Math.max(3, Math.min(unfiltered.machineCount, 6))} />
            ) : unreadableGroup ? (
                renderUnreadable(unreadableGroup, true)
            ) : empty && managedReadFailures.length > 0 ? null : empty ? (
                <Item
                    testID="settings.machines.rail.empty"
                    title={t('newSession.noMachinesFound')}
                    density="compact"
                    showChevron={false}
                    mode="info"
                />
            ) : collection.sections.map((section) => section.archived ? (
                <ArchivedMachineSection key={section.key} section={section} rail
                    selectedKey={selectedKey} query={searchable ? query : ''} renderRow={renderMachineRow} />
            ) : (
                <React.Fragment key={section.key}>
                    {section.title ? (
                        <CollectionListGroupLabel
                            title={section.title}
                            // One group already has its count in the header: say it once.
                            count={collection.sections.length > 1 ? section.rows.length : undefined}
                        />
                    ) : null}
                    {section.rows.length === 0 && !noMatches && section.status === 'error' ? (
                        renderUnreadable({ serverId: section.serverId, serverName: section.title ?? '' }, true)
                    ) : section.rows.length === 0 ? (
                        <Item
                            title={noMatches ? t('common.noMatches') : (sectionStatusLabel(section) ?? t('newSession.noMachinesFound'))}
                            density="compact"
                            showChevron={false}
                            mode="info"
                        />
                    ) : renderRailSectionRows(section)}
                </React.Fragment>
            ))}
            {/* The column fills top-down: what follows the machines waits for them, so nothing lands above them and moves. */}
            {loading ? null : <>
                {thisComputerRow}
                <MachinePoolsSection groups={viewModel.visibleMachineGroups} variant="rail" selectedKey={selectedKey} />
                {presetSections}
            </>}
        </CollectionList>
    );
});

/** The Homes whose created-machine inventory could not be read: their notice, not an empty Home. */
export function readManagedMachineReadFailures(viewModel: MachinesSettingsViewModel) {
    return viewModel.visibleMachineGroups.filter(group => {
        const status = viewModel.managedInventory?.entries[group.serverId]?.status;
        return status === 'error' || status === 'denied'
            || (status === 'unsupported' && (viewModel.managedByServerId?.[group.serverId]?.length ?? 0) > 0)
            || viewModel.managedInventory?.accountScopes.get(group.serverId)?.resolution.kind === 'unavailable';
    });
}

/** A Home whose machine list could not be read ends in that fact, with Retry for the focused Home. */
export function MachineHomeUnreadableRow(props: Readonly<{
    group: Readonly<{ serverId: string; serverName: string }>;
    compact: boolean;
    /** Retry reads the focused Home again; another Home recovers through its own connection. */
    canRetry: boolean;
}>) {
    const { execute } = useMountedActionExecution(props.group.serverId);
    const retry = React.useCallback(async () => {
        const result = await execute('machines.list', { serverId: props.group.serverId, refresh: true });
        if (!result.ok) throw new Error(result.error);
    }, [execute, props.group.serverId]);
    return (
        <Item
            testID="settings.machines.unreadable"
            title={t('settingsMachines.unreadableTitle', { home: props.group.serverName })}
            titleLines={0}
            density={props.compact ? 'compact' : undefined}
            showChevron={false}
            mode="info"
            rightElement={props.canRetry ? (
                <RoundButton
                    testID="settings.machines.unreadable.retry"
                    size="small"
                    display="secondary"
                    title={t('common.retry')}
                    onPress={() => fireAndForget(retry(), { tag: 'MachineCollectionList.retry' })}
                />
            ) : undefined}
        />
    );
}

/** Retired resources remain recoverable without rejoining the active Machines list. */
function ArchivedMachineSection(props: Readonly<{
    section: MachineCollectionSection;
    rail: boolean;
    selectedKey: string | null;
    query: string;
    renderRow: (row: MachineCollectionRow) => React.ReactElement;
}>) {
    const disclosure = <MachineRowsFold testID={`settings.machines.archived.${props.section.serverId}`} title={t('managedCleanup.archiveTitle')}
        rows={props.section.rows} rail={props.rail} selectedKey={props.selectedKey} query={props.query} renderRow={props.renderRow} />;
    return props.rail ? disclosure : <ItemGroup title={props.section.title ?? undefined}>{disclosure}</ItemGroup>;
}

function MachineRowsFoldCaret(props: Readonly<{ expanded: boolean }>) {
    const { theme } = useUnistyles();
    return <Icon name={props.expanded ? 'caret-down' : 'caret-right'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />;
}

/** Rows kept under one fold, with their count; it opens while one of them is selected or a search is typed. */
function MachineRowsFold(props: Readonly<{
    testID: string;
    title: string;
    rows: readonly MachineCollectionRow[];
    rail: boolean;
    selectedKey: string | null;
    query: string;
    renderRow: (row: MachineCollectionRow) => React.ReactElement;
}>) {
    const [expanded, setExpanded] = React.useState(false);
    const selected = props.rows.some(row => isMachineCollectionRowSelected(props.selectedKey, row));
    return <ExpandableItem expanded={expanded || selected || props.query.trim().length > 0}
        // In the rail the fold is one more row of the list: no hairline of its own.
        onExpandedChange={setExpanded} {...(props.rail ? { showDivider: false } : {})} header={state => <Item {...state.headerProps}
            testID={props.testID}
            title={props.title} detail={String(props.rows.length)}
            // The rail's row geometry: the caret stands in the mark column, so the title lines up with the names.
            {...(props.rail ? { pressableStyle: collectionListStyles.row, showDivider: false, icon: (
                <HappierCollectionListMark>
                    <MachineRowsFoldCaret expanded={state.expanded} />
                </HappierCollectionListMark>
            ) } : {})}
            density={props.rail ? 'compact' : undefined} showChevron={false} /> }>
        {props.rows.map(props.renderRow)}
    </ExpandableItem>;
}

/** Accessible recipes remain separate from resources, with exact-Home read and approval custody. */
export function MachinePresetCollectionSectionView(props: Readonly<{
    section: MachinePresetCollectionSection;
    state?: MachinePresetQueryState<readonly ManagedMachinePresetV1[]>;
    rail: boolean;
    selectedKey: string | null;
    replacing: boolean;
    query: string;
    refresh?: () => void;
}>) {
    const router = useRouter();
    const scopeKey = JSON.stringify([props.section.serverId, props.state?.approval]);
    const approval = useActionApprovalContinuation({ scopeKey, serverId: props.section.serverId, onExecuted: () => {} });
    React.useEffect(() => {
        if (props.state?.approval) approval.requestApproval(props.state.approval);
    }, [props.state?.approval, approval.requestApproval]);
    const title = [t('machinePresets.short'), props.section.title].filter(Boolean).join(' · ');
    const newHref = `/settings/machines/presets/new?serverId=${encodeURIComponent(props.section.serverId)}`;
    // The group's own "+" creates a preset (lab `m-presets`); it waits until the list is readable.
    // A re-read keeps the last answer on screen: "loading" is only the wait for the first one.
    const awaiting = props.state?.loading === true && props.state.value == null;
    const add = !awaiting && !props.state?.error ? <IconButton testID={`settings.machines.presets.new.${props.section.serverId}`}
        iconName="plus" accessibilityLabel={t('machinePresets.newPreset')} variant="plain"
        onPress={() => openHref(router, newHref, props.replacing, 'MachinePresetCollection.new')} /> : null;
    const rows = <>
        {approval.approvalId ? <Item testID={`settings.machines.presets.approval.${props.section.serverId}`}
            title={t('approvals.status.open')} density={props.rail ? 'compact' : undefined}
            onPress={() => openHref(router, `/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.section.serverId)}`, false, 'MachinePresetCollection.approval')} /> : null}
        {props.state?.error ? <SurfaceStateCard testID={`settings.machines.presets.error.${props.section.serverId}`}
            size="line" kind={props.state.error === 'permission_denied' || props.state.error === 'signed_out' ? 'denied' : 'unavailable'}
            title={props.state.error === 'permission_denied' || props.state.error === 'signed_out' ? t('machinePresets.accessLost') : t('machinePresets.loadFailed')}
            diagnosticCode={props.state.error} action={props.refresh ? { label: t('common.retry'), onPress: props.refresh } : undefined} /> : null}
        {props.section.rows.map(row => {
            const render = (audience: string) => <Item key={machineCollectionRowKey(row)} testID={`settings.machines.preset.${row.serverId}.${row.presetId}`}
            title={row.title}
            // The rail is an index: one line, with who it is for as the right-hand fact (lab m-presets).
            {...(props.rail ? { detail: row.preset.archivedAt !== undefined ? t('machinePresets.archivedShort') : audience }
                : { subtitle: row.preset.archivedAt !== undefined ? `${audience} · ${t('machinePresets.archived')}` : audience })}
            // The preset's provider mark, as the preset page draws it (lab m-presets rail).
            icon={<HappierCollectionListMark><ManagedPresetMark serverId={row.serverId} preset={row.preset}
                size={props.rail ? MANAGED_PROVISIONER_MARK_SIZE.rail : MANAGED_PROVISIONER_MARK_SIZE.row} /></HappierCollectionListMark>}
            density={props.rail ? 'compact' : undefined} selected={props.rail ? isMachineCollectionRowSelected(props.selectedKey, row) : undefined}
            showChevron={!props.rail} pressableStyle={props.rail ? collectionListStyles.row : undefined}
            onPress={() => { recordMachineCollectionVisit({ ...row, query: props.query });
                openHref(router, machineCollectionHref(row), props.replacing, 'MachinePresetCollection.open'); }} />;
            return row.preset.owner.kind === 'team' ? <MachinePresetTeamCollectionRow key={machineCollectionRowKey(row)}
                serverId={row.serverId} teamId={row.preset.owner.teamId} knownName={row.teamName} render={render} /> : render(row.audience);
        })}
        {/* Loading and empty are one line on the rows' edge, so the section never shifts when the answer arrives. */}
        {props.section.rows.length === 0 && !props.state?.error ? (
            <EmptyState testID={`settings.machines.presets.empty.${props.section.serverId}`} layout="line"
                title={awaiting ? t('machinePresets.loading') : props.query.trim() ? t('common.noMatches') : t('machinePresets.empty')}
                lineLoading={awaiting}
                />) : null}
    </>;
    if (!props.rail) return <ItemGroup title={title} action={add}>{rows}</ItemGroup>;
    return <><CollectionListGroupLabel title={title} trailing={add} />
        {rows}</>;
}

/**
 * The machine being added (lab `add-flows` M4/M5), at the top of the rail while its form is open or its
 * setup is still running elsewhere: titled by its host once typed, with the live step. Pressing it
 * opens the form again. It reads only the flow's narrow row projection.
 */
const MachineDraftRow = React.memo(function MachineDraftRow(props: Readonly<{ selected: boolean; replace: boolean }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const row = useMachineAddDraftRow();
    if (!row && !props.selected) return null;
    const tone = row?.tone ?? 'waiting';
    return (
        <Item
            testID="settings.machines.rail.draft"
            title={row?.title ?? t('machineAdd.newMachine')}
            subtitle={row?.status ?? t('common.draft')}
            subtitleLeading={row ? (
                <StatusDot
                    color={tone === 'failed' ? theme.colors.status.error : tone === 'arrived' ? theme.colors.status.connected : theme.colors.status.connecting}
                    isPulsing={tone === 'waiting' || tone === 'running'}
                />
            ) : undefined}
            icon={(
                <HappierCollectionListMark>
                    <Icon name="plus" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={props.selected}
            density="compact"
            showChevron={false}
            pressableStyle={collectionListStyles.row}
            onPress={() => openHref(router, MACHINES_ADD_ROUTE, props.replace, 'MachineCollectionList.draft')}
        />
    );
});

/** The pool being added, at the top of the rail while its editor is open. */
const MachinePoolDraftRow = React.memo(function MachinePoolDraftRow() {
    const machinePoolDraftTitle = useCollectionDraftTitle();
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            testID="settings.machines.rail.poolDraft"
            titles={machinePoolDraftTitle}
            placeholder={t('machinePools.newPoolTitle')}
            mark={(
                <HappierCollectionListMark>
                    <Icon name="stack" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
        />
    );
});

/** The rail beside a machine's detail. */
export const MachineCollectionRail = React.memo(function MachineCollectionRail() {
    const viewModel = useMachinesSettingsViewModel();
    const addOptions = useMachineAddOptions(viewModel.visibleMachineGroups);
    return <MachineCollectionList variant="rail" viewModel={viewModel} addOptions={addOptions} />;
});

const stylesheet = StyleSheet.create(() => ({
}));
