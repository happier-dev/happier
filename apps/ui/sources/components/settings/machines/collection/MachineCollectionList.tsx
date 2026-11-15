import * as React from 'react';
import { resolveMachineKindGlyph } from '@/components/machines/machineKindGlyph';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { View, type Pressable } from 'react-native';
import { useMachineCollection, useMachineCollectionPresenceRows, useMachineCollectionRowPresence } from './useMachineCollection';
import { useGlobalSearchParams, useOpenAppSection, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { Item } from '@/components/ui/lists/Item';
import { MachineFleetUpdatesEntry } from '@/components/machines/updates/MachineFleetUpdatesEntry';
import { machineFleetPageHref } from '@/components/machines/page/machinePageHref';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
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
import { InlineStatus } from '@/components/ui/status/InlineStatus';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { MachinePresetQueryState } from '../managed/useMachinePresets';
import type { ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { ManagedMachineReadApprovalNotice } from '../managed/ManagedMachineReadApprovalNotice';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { MANAGED_PROVISIONER_MARK_SIZE, ManagedPresetMark } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { useMachineResourceFleetAttention } from '@/sync/domains/machines/resources/useMachineResourceFleetAttention';
import { useMachineSummarySettingValue } from '@/components/machines/summary/useMachineSummarySetting';
import { MachineListRowSummary } from '@/components/machines/summary/MachineListRowSummary';
import { MachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { useThisComputerServiceSummary } from '../localControl/useThisComputerServiceSummary';

const FIRST_READ = Object.freeze({ kind: 'loading' } as const);

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;

/** The directory batches known owners; an owner beyond its current page uses the same exact Team reader as detail. */
function MachinePresetTeamCollectionRow(props: Readonly<{
    serverId: string; teamId: string; knownName?: string; render: (audience: string) => React.ReactElement;
}>) {
    const binding = useTeamBinding(props.serverId, props.knownName ? '' : props.teamId);
    const state = binding.kind === 'bound' ? binding.state : null;
    // While the Team's name is read the row's audience stays empty, never a "Loading…" fact (TH D12).
    const name = props.knownName ?? (state?.kind === 'ready' && state.team.capabilities.viewTeam ? state.team.name
        : state?.kind === 'unavailable' ? t('common.unavailable') : '');
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
    /** Receives the menu's opener, so a main screen's bar "+" opens the same menu as this "+". */
    openerRef?: React.MutableRefObject<(() => void) | null>;
}>) {
    const router = useRouter();
    const [open, setOpen] = React.useState(false);
    const openerRef = props.openerRef;
    const available = props.options.length > 0;
    React.useEffect(() => {
        if (!openerRef || !available) return;
        openerRef.current = () => setOpen(true);
        return () => { openerRef.current = null; };
    }, [available, openerRef]);
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
 * One machine's row. Memoized on its (key-stable) row so a single Machine's change re-renders one row, not
 * the column; `selected` and the open callback are the only other inputs.
 */
const MachineListRow = React.memo(function MachineListRow(props: Readonly<{
    row: MachineCollectionRow;
    rail: boolean;
    selected: boolean;
    selectedRef: React.Ref<React.ComponentRef<typeof Pressable>> | undefined;
    onOpen: (row: MachineCollectionRow) => void;
}>) {
    const { theme } = useUnistyles();
    const { rail, selected, selectedRef, onOpen } = props;
    const row = useMachineCollectionRowPresence(props.row);
    const thisComputerMachineId = useThisComputerMachineId();
    const isThisComputer = (row.kind === 'machine' ? row.machineId : row.enrolledMachineId) === thisComputerMachineId;
    const summaryMetrics = useMachineSummarySettingValue().metrics.length;
    const summaryRef = React.useRef<View>(null);
    const quietWord = row.reason ?? row.presenceWord ?? row.ownership;
    // The rail's one word: a native word (Asleep) as the presence owner says it; a machine that is simply offline
    // says Offline, its last-seen time staying in the accessible name and on its page.
    const railWord = row.reason ?? (row.kind === 'managed' || row.presenceSource?.managedPresence ? row.presenceWord
        : row.fleetPresence?.online === false ? t('machineDetailPage.offline') : row.presenceWord) ?? row.ownership;
    // Only a reachable machine with instruments chosen has a live summary to show.
    const liveSummary = row.kind === 'machine' && row.online && summaryMetrics > 0;
    return (
        rail ? (
            // One line (lab m-defaults rail): the name, then its one word at the row's end. A machine whose live summary
            // is shown keeps that summary on the line beneath; the host and platform stay in the accessible name.
            <Item
                rowRole="catalogRow"
                key={machineCollectionRowKey(row)}
                testID={row.kind === 'managed' ? `settings.machines.managed.${row.serverId}.${row.managedId}` : `settings.machines.row.${row.serverId}.${row.machineId}`}
                title={row.titleParts.name}
                titleQualifier={row.titleParts.hint}
                detail={liveSummary ? undefined : railWord ?? undefined}
                subtitle={liveSummary ? (
                    <MachineResourceLiveDemand
                        machineKeys={[{ serverId: row.serverId, machineId: row.machineId }]}
                        detail="summary" enabled viewportRef={summaryRef}>
                    {measure => <View ref={summaryRef} collapsable={false} onLayout={measure} style={railRowStyles.line}>
                        <MachineListRowSummary
                            testID={`settings.machines.row.${row.serverId}.${row.machineId}.summary`}
                            serverId={row.serverId}
                            machineId={row.machineId}
                            online={row.online}
                            quietWord={quietWord}
                        />
                    </View>}
                    </MachineResourceLiveDemand>
                ) : undefined}
                accessibilityLabel={[row.title, statusLine(row, true)].filter(Boolean).join(', ')}
                icon={(
                    <HappierCollectionListMark rowRole="catalogRow">
                        <Icon name={resolveMachineKindGlyph({ isThisComputer, platform: row.platform })} size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                )}
                selected={selected}
                pressableRef={selected ? selectedRef : undefined}
                density="compact"
                showChevron={false}
                pressableStyle={collectionListStyles.row}
                onPress={() => onOpen(row)}
            />
        ) : (
            <Item
                rowRole="catalogRow"
                key={machineCollectionRowKey(row)}
                testID={row.kind === 'managed' ? `settings.machines.managed.${row.serverId}.${row.managedId}` : `settings.machines.row.${row.serverId}.${row.machineId}`}
                title={row.title}
                // A Machine's presence is its state line through the one inline Status (UI refinements 2026-11-15 08:57Z).
                subtitle={row.kind === 'managed' ? statusLine(row, !rail) : (
                    <InlineStatus
                        testID={`settings.machines.row.${row.serverId}.${row.machineId}.presence`}
                        tone={row.online ? 'success' : 'muted'}
                        label={statusLine(row, !rail)}
                    />
                )}
                subtitleAccessory={rail || row.kind === 'managed' ? undefined : (
                    <MachineCliGlyphs machineId={row.machineId} serverId={row.serverId} isOnline={row.online} />
                )}
                icon={(
                    <HappierCollectionListMark rowRole="catalogRow">
                        <Icon name={resolveMachineKindGlyph({ isThisComputer, platform: row.platform })} size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                )}
                selected={rail ? selected : undefined}
                density={rail ? 'compact' : undefined}
                showChevron={!rail}
                pressableStyle={rail ? collectionListStyles.row : undefined}
                onPress={() => onOpen(row)}
            />
        )
    );
});

/**
 * The Machines collection: this computer (desktop app), the machines of each Home the app shows, then
 * their machine pools. `rail` is the narrow list beside the open detail; `page` is the same list as
 * page sections where no rail shows. Selection comes from the route.
 */
export const MachineCollectionList = React.memo(function MachineCollectionList(props: Readonly<{
    /**
     * `configuration`: only the collection's configuration (defaults, this computer, pools, presets) and its
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
    // The fleet pages are the Machines destination's (RULING 11-14 20:24Z): from Settings → Machines they open as that
    // section, so their shell column is Machines; inside the rail door they open in place like any row.
    const openSection = useOpenAppSection();
    const openFleetPage = (page: 'updates' | 'activity') => door === 'settings'
        ? openSection(machineFleetPageHref(page))
        : openHref(router, machineFleetPageHref(page), replaceConfiguration, `MachineCollectionList.${page}`);
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

    React.useEffect(() => {
        const selected = collection.sections.flatMap(section => section.rows).find(row => isMachineCollectionRowSelected(selectedKey, row));
        if (selected) recordMachineCollectionVisit({ ...selected, query });
    }, [selectedKey, collection, query]);

    const openMachine = React.useCallback((row: MachineCollectionRow) => {
        recordMachineCollectionVisit({ ...row, query });
        // Beside a detail, switching machines replaces the shown detail instead of stacking history.
        openHref(router, machineCollectionHref(row, door), rail && onDetailRoute, 'MachineCollectionList.openMachine');
    }, [door, onDetailRoute, query, rail, router]);

    // A long fleet opens on its selected machine, not at the top of the column.
    const selectedPresent = rail && collection.sections.some(section => section.rows.some(row => isMachineCollectionRowSelected(selectedKey, row)));
    const selectedRowRef = useRevealSelectedRow<React.ComponentRef<typeof Pressable>>(selectedKey, selectedPresent);

    const renderMachineRow = (row: MachineCollectionRow) => {
        if (row.hydrating) return <CollectionSkeletonRows key={machineCollectionRowKey(row)} count={1} rowRole="catalogRow" />;
        const selected = isMachineCollectionRowSelected(selectedKey, row);
        return <MachineListRow key={machineCollectionRowKey(row)} row={row} rail={rail} selected={selected}
            selectedRef={selected ? selectedRowRef : undefined} onOpen={openMachine} />;
    };

    const thisComputerRow = isDesktop ? (
        <ThisComputerCollectionRow rail={rail} selected={rail && selectedKey === 'thisComputer'} replace={replaceConfiguration} />
    ) : null;

    // Machine defaults (D21) open from the top of the list, above the machines they apply to. Its name alone, as
    // Updates and Activity beside it (owner 11-11: no value; its page says what it governs).
    const defaultsRow = (
        <Item
            rowRole="catalogRow"
            testID="settings.machines.defaults"
            title={t('managedRetention.defaults')}
            icon={(
                <HappierCollectionListMark rowRole="catalogRow">
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

    // Fleet OS updates (pfc-redesign fUpd) sit under Defaults: one page for every machine's system packages; the
    // entry says how many machines have updates waiting (lab mIdx), as the Overview says how many need a look.
    const updatesRow = (
        <MachineFleetUpdatesEntry
            serverId={viewModel.activeServerId}
            item={{
                rowRole: 'catalogRow',
                testID: 'settings.machines.updates',
                title: t('machineFleetUpdates.title'),
                icon: (
                    <HappierCollectionListMark rowRole="catalogRow">
                        <Icon name="download" size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                ),
                selected: rail ? selectedKey === 'updates' : undefined,
                density: rail ? 'compact' : undefined,
                showChevron: !rail,
                pressableStyle: rail ? collectionListStyles.row : undefined,
                onPress: () => openFleetPage('updates'),
            }}
        />
    );

    // Fleet Activity (pfc-redesign fAct): the history of what ran on these machines; attention stays in Inbox.
    const activityRow = (
        <Item
            rowRole="catalogRow"
            testID="settings.machines.activity"
            title={t('machineFleetActivity.title')}
            icon={(
                <HappierCollectionListMark rowRole="catalogRow">
                    <Icon name="clock" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={rail ? selectedKey === 'activity' : undefined}
            density={rail ? 'compact' : undefined}
            showChevron={!rail}
            pressableStyle={rail ? collectionListStyles.row : undefined}
            onPress={() => openFleetPage('activity')}
        />
    );

    // Readable rows remain visible while a new Machine's own reserved slot waits for its name.
    const loading = (total === 0 && viewModel.isLoadingMachines) || collection.firstAnswerPending;
    const empty = !loading && total === 0;
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
    const renderRailSectionRows = (section: MachineCollectionSection, counted: boolean) => {
        return <RailSectionRows section={section} foldOffline={searchable} counted={counted} selectedKey={selectedKey}
            query={query} renderRow={renderMachineRow} />;
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
                <ItemGroup>{defaultsRow}{updatesRow}{activityRow}{thisComputerRow}</ItemGroup>
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
                <ItemGroup>{defaultsRow}{updatesRow}{activityRow}{thisComputerRow}</ItemGroup>
                {renderManagedReadFailures()}
                {managedReadApprovals}
                {loading ? (
                    <ItemGroup title={t('settings.machines')}>
                        <ItemLoadStateRows state={FIRST_READ} rows={3} lines={2} accessibilityLabel={t('settings.machines')} />
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
                                title={noMatches ? t('common.noMatches') : t('settingsMachines.emptyTitle')}
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
        <>
        <CollectionList
            testID="settings.machines.rail"
            // No header count (lab m-defaults rail): each group says how many it lists, and the fleet total (which counts
            // archived creations' enrollments too) belongs to All machines, where it doesn't contradict visible groups.
            title={t('settings.machines')}
            headerAction={<AddMachineMenu options={addOptions} replaceInCollection={replaceConfiguration} />}
            search={searchable ? {
                value: query,
                onChangeText: setQuery,
                placeholder: t('settingsMachines.searchPlaceholder'),
                testID: 'settings.machines.rail.search',
            } : null}
        >
            {/* The fleet first (lab `R`): the Overview is the index of both doors. */}
            <CollectionIndexRow
                testID="settings.machines.rail.all"
                detail={fleetLookCount > 0 ? t('machineAttention.listNeedLook', { count: fleetLookCount }) : undefined}
                selected={selectedKey === 'allMachines'}
                onPress={() => openHref(router, doorRoot, onDetailRoute, 'MachineCollectionList.allMachines')}
            />
            {/* Defaults head the list, above the machines they apply to (lab m-defaults). */}
            {defaultsRow}
            {updatesRow}
            {activityRow}
            {renderManagedReadFailures()}
            {managedReadApprovals}
            {/* The machines are one section (owner 11-11): the one being added, this computer, then the fleet. */}
            <CollectionListGroupLabel testID="settings.machines.rail.machinesLabel" title={t('settings.machines')} />
            <MachineDraftRow selected={selectedKey === 'machineDraft'} replace={replaceConfiguration} />
            {thisComputerRow}
            {loading ? (
                <CollectionSkeletonRows count={Math.max(3, Math.min(unfiltered.machineCount, 6))} rowRole="catalogRow" />
            ) : unreadableGroup ? (
                renderUnreadable(unreadableGroup, true)
            ) : empty && managedReadFailures.length > 0 ? null : empty ? (
                // On the desktop app "This machine" stands above and says its own state; elsewhere the section
                // says it is empty and leads to adding one.
                thisComputerRow ? null : <MachinesEmptyLine draftSelected={selectedKey === 'machineDraft'} replace={replaceConfiguration} />
            ) : collection.sections.map((section) => section.archived ? (
                <ArchivedMachineSection key={section.key} section={section} rail
                    selectedKey={selectedKey} query={searchable ? query : ''} renderRow={renderMachineRow} />
            ) : (
                <React.Fragment key={section.key}>
                    {/* A group with rows draws its label with them, counting what it lists inline (RailSectionRows). */}
                    {section.title && section.rows.length === 0 ? (
                        <CollectionListGroupLabel level="subgroup" title={section.title}
                            count={collection.sections.length > 1 ? 0 : undefined} />
                    ) : null}
                    {section.rows.length === 0 && !noMatches && section.status === 'error' ? (
                        renderUnreadable({ serverId: section.serverId, serverName: section.title ?? '' }, true)
                    ) : section.rows.length === 0 ? (
                        <Item
                            title={noMatches ? t('common.noMatches') : (sectionStatusLabel(section) ?? t('settingsMachines.emptyTitle'))}
                            density="compact"
                            showChevron={false}
                            mode="info"
                        />
                    ) : renderRailSectionRows(section, collection.sections.length > 1)}
                </React.Fragment>
            ))}
            {/* The column fills top-down: what follows the machines waits for them, so nothing lands above them and moves. */}
            {selectedKey?.startsWith('poolDraft:') ? <MachinePoolDraftRow /> : null}
            {loading ? null : <>
                <MachinePoolsSection groups={viewModel.visibleMachineGroups} variant="rail" selectedKey={selectedKey} />
                {presetSections}
            </>}
        </CollectionList>
        </>
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

/** The offline fold follows transitions locally; the collection's structure remains subscribed to inventory alone. */
function RailSectionRows(props: Readonly<{
    section: MachineCollectionSection;
    foldOffline: boolean;
    /** Several groups: each label says its count (one group already has its count in the header: say it once). */
    counted: boolean;
    selectedKey: string | null;
    query: string;
    renderRow: (row: MachineCollectionRow) => React.ReactElement;
}>) {
    const rows = useMachineCollectionPresenceRows(props.section.rows);
    const { inline, offline } = partitionMachineCollectionRailRows(rows, props.foldOffline);
    return <>
        {/* A Home's machines are a group inside the Machines section. Its count is what it lists inline, as the
            Machines table counts: the Offline fold below says its own count. */}
        {props.section.title ? <CollectionListGroupLabel level="subgroup" title={props.section.title}
            count={props.counted ? inline.length : undefined} /> : null}
        {inline.map(props.renderRow)}
        {offline.length > 0 ? <MachineRowsFold testID={`settings.machines.offline.${props.section.key}`}
            title={t('machineDetailPage.offline')} rows={offline} rail selectedKey={props.selectedKey}
            query={props.query} renderRow={props.renderRow} /> : null}
    </>;
}

function MachineRowsFoldCaret(props: Readonly<{ expanded: boolean }>) {
    const { theme } = useUnistyles();
    return <DisclosureCaret expanded={props.expanded} size={ICON_SIZE.xs} />;
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
            // Off the rail the Item draws the canonical disclosure caret itself.
            density={props.rail ? 'compact' : undefined} {...(props.rail ? { showChevron: false } : {})} /> }>
        {props.rows.map(props.renderRow)}
    </ExpandableItem>;
}

/**
 * Accessible presets remain separate from resources, with exact-Home read and approval custody. Memoized on its
 * (key-stable) section: a Machine arriving or opening redraws the rail, never this group's rows.
 */
export const MachinePresetCollectionSectionView = React.memo(function MachinePresetCollectionSectionView(props: Readonly<{
    section: MachinePresetCollectionSection;
    state?: MachinePresetQueryState<readonly ManagedMachinePresetListEntryV1[]>;
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
            // The same rail anatomy as machine and pool rows: the name keeps its line, the fact yields (TH D2).
            rowRole="catalogRow"
            title={row.title}
            // The rail is an index: the name keeps its line; a short fact (Yours, Archived) sits at its end, while a Team's
            // name, which can be as long as the preset's, moves beneath it so neither truncates the other (TH D2).
            {...(props.rail ? row.preset.archivedAt === undefined && row.preset.owner.kind === 'team'
                ? { subtitle: audience || undefined }
                : { detail: row.preset.archivedAt !== undefined ? t('machinePresets.archivedShort') : audience || undefined }
                : { subtitle: row.preset.archivedAt !== undefined ? [audience, t('machinePresets.archived')].filter(Boolean).join(' · ') : audience || undefined })}
            // The preset's provider mark, as the preset page draws it (lab m-presets rail).
            icon={<HappierCollectionListMark rowRole="catalogRow"><ManagedPresetMark serverId={row.serverId} preset={row.preset}
                size={props.rail ? MANAGED_PROVISIONER_MARK_SIZE.rail : MANAGED_PROVISIONER_MARK_SIZE.row} /></HappierCollectionListMark>}
            density={props.rail ? 'compact' : undefined} selected={props.rail ? isMachineCollectionRowSelected(props.selectedKey, row) : undefined}
            showChevron={!props.rail} pressableStyle={props.rail ? collectionListStyles.row : undefined}
            onPress={() => { recordMachineCollectionVisit({ ...row, query: props.query });
                openHref(router, machineCollectionHref(row), props.replacing, 'MachinePresetCollection.open'); }} />;
            return row.preset.owner.kind === 'team' ? <MachinePresetTeamCollectionRow key={machineCollectionRowKey(row)}
                serverId={row.serverId} teamId={row.preset.owner.teamId} knownName={row.teamName} render={render} /> : render(row.audience);
        })}
        {/* Loading and empty are one line on the rows' edge, so the section never shifts when the answer arrives. */}
        {/* The first read reserves its row quietly (TH D12); empty is one line on the rows' edge. */}
        {props.section.rows.length === 0 && !props.state?.error ? awaiting ? (
            <ItemLoadStateRows state={FIRST_READ} rows={1} lines={1} shape={props.rail ? 'list' : undefined}
                accessibilityLabel={t('machinePresets.short')} testID={`settings.machines.presets.loading.${props.section.serverId}`} />
        ) : (
            <EmptyState testID={`settings.machines.presets.empty.${props.section.serverId}`} layout="line"
                title={props.query.trim() ? t('common.noMatches') : t('machinePresets.empty')}
                />) : null}
    </>;
    if (!props.rail) return <ItemGroup title={title} action={add}>{rows}</ItemGroup>;
    return <><CollectionListGroupLabel title={title} actions={add ?? undefined} />
        {rows}</>;
});

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
    const tone = row?.tone ?? 'draft';
    return (
        <Item
            rowRole="item"
            testID="settings.machines.rail.draft"
            title={row?.title ?? t('machineAdd.newMachine')}
            subtitle={row?.status ? (
                <InlineStatus
                    tone={tone === 'failed' ? 'danger' : tone === 'arrived' ? 'success' : 'info'}
                    pulsing={tone === 'waiting' || tone === 'running'}
                    label={row.status}
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

/**
 * This computer (desktop app): its row says the background service's state from the one summary owner, so an empty
 * Machines list never claims there is no machine while this one waits to be set up or repaired.
 */
const ThisComputerCollectionRow = React.memo(function ThisComputerCollectionRow(props: Readonly<{
    rail: boolean;
    selected: boolean;
    replace: boolean;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const summary = useThisComputerServiceSummary();
    const needsYou = summary?.needsYou === true;
    return (
        <Item
            rowRole="catalogRow"
            testID="settings.machines.thisComputer"
            title={t('settingsMachines.thisComputerTitle')}
            subtitle={needsYou && summary.title
                ? <InlineStatus testID="settings.machines.thisComputer.attention" tone="warning" label={summary.title} />
                : needsYou ? undefined : t('settingsMachines.thisComputerRowSubtitle')}
            icon={(
                <HappierCollectionListMark rowRole="catalogRow">
                    <Icon name="laptop" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={props.rail ? props.selected : undefined}
            density={props.rail ? 'compact' : undefined}
            showChevron={!props.rail}
            pressableStyle={props.rail ? collectionListStyles.row : undefined}
            onPress={() => openHref(router, MACHINES_THIS_COMPUTER_ROUTE, props.replace, 'MachineCollectionList.thisComputer')}
        />
    );
});

/** An empty Machines section says so and leads to adding one, unless the machine being added already stands there. */
const MachinesEmptyLine = React.memo(function MachinesEmptyLine(props: Readonly<{ draftSelected: boolean; replace: boolean }>) {
    const router = useRouter();
    const draft = useMachineAddDraftRow();
    if (draft || props.draftSelected) return null;
    return (
        <EmptyState testID="settings.machines.rail.empty" layout="line" title={t('settingsMachines.emptyTitle')}
            primaryAction={{ label: t('settings.addMachine'), testID: 'settings.machines.rail.empty.add',
                onPress: () => openHref(router, MACHINES_ADD_ROUTE, props.replace, 'MachineCollectionList.emptyAdd') }} />
    );
});

/** The pool being added, at the top of the rail while its editor is open. */
const MachinePoolDraftRow = React.memo(function MachinePoolDraftRow() {
    const machinePoolDraftTitle = useCollectionDraftTitle();
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            rowRole="item"
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

const railRowStyles = StyleSheet.create((theme) => ({
    line: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minWidth: 0 },
}));

const stylesheet = StyleSheet.create(() => ({
}));
