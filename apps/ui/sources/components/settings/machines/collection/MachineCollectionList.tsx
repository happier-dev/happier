import * as React from 'react';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useMachinesSettingsViewModel, type MachinesSettingsViewModel } from '../machinesSettingsViewModel';
import { MachinePoolsSection } from '../sections/MachinePoolsSection';
import { machinePoolDraftTitle } from '../pools/machinePoolDraftTitle';
import {
    MACHINES_ADD_ROUTE,
    MACHINES_THIS_COMPUTER_ROUTE,
    buildMachineCollection,
    isMachineCollectionRowSelected,
    machineCollectionHref,
    machineCollectionRowKey,
    resolveSelectedMachineCollectionKey,
    type MachineCollectionRow,
    type MachineCollectionSection,
    type MachinePresetCollectionSection,
} from './machineCollectionModel';
import { recordMachineCollectionVisit, readLastVisitedMachine } from './machineCollectionVisit';
import { useMachineAddOptions, type MachineAddOption } from './useMachineAddOptions';
import { useMachineAddDraftRow } from '@/components/machines/add/useMachineAddFlow';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { sync } from '@/sync/sync';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { MachinePresetQueryState } from '../managed/useMachinePresets';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedMachineReadApprovalNotice } from '../managed/ManagedMachineReadApprovalNotice';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';

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
    variant: 'rail' | 'page';
    viewModel: MachinesSettingsViewModel;
    addOptions: readonly MachineAddOption[];
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const params = useGlobalSearchParams<{ serverId?: string | string[] }>();
    const { viewModel, addOptions } = props;
    const presenceMachines = React.useMemo(() => viewModel.visibleMachineGroups.flatMap(group => group.machines), [viewModel.visibleMachineGroups]);
    const nowMs = useMachinePresenceNowMs(presenceMachines);
    const isDesktop = isDesktopHost();
    const rail = props.variant === 'rail';
    const onDetailRoute = pathname.startsWith('/settings/machines/');
    const selectedKey = rail ? resolveSelectedMachineCollectionKey(pathname, { serverId: readParam(params.serverId) }) : null;

    const [query, setQuery] = React.useState(() => readLastVisitedMachine()?.query ?? '');
    const total = React.useMemo(
        () => buildMachineCollection({ groups: viewModel.visibleMachineGroups,
            groupedByHome: viewModel.showMachinesGroupedByServer, managedByServerId: viewModel.managedByServerId,
            presetsByServerId: viewModel.presetsByServerId }).count,
        [viewModel.visibleMachineGroups, viewModel.showMachinesGroupedByServer, viewModel.managedByServerId, viewModel.presetsByServerId],
    );
    const searchable = total > SEARCH_THRESHOLD;
    const teamServerIds = React.useMemo(() => Object.entries(viewModel.presetsByServerId ?? {})
        .filter(([, presets]) => presets.some(preset => preset.owner.kind === 'team')).map(([serverId]) => serverId), [viewModel.presetsByServerId]);
    const teams = useTeamsDirectory({ serverIds: teamServerIds, enabled: teamServerIds.length > 0, archived: 'all' });
    const teamNamesByServerId = React.useMemo(() => {
        const names: Record<string, Record<string, string>> = {};
        for (const row of [...teams.rows, ...teams.archivedRows]) (names[row.address.serverId] ??= {})[row.team.id] = row.team.name;
        return names;
    }, [teams.rows, teams.archivedRows]);
    const collection = React.useMemo(() => buildMachineCollection({
        nowMs,
        groups: viewModel.visibleMachineGroups,
        groupedByHome: viewModel.showMachinesGroupedByServer,
        query: searchable ? query : '',
        managedByServerId: viewModel.managedByServerId,
        presetsByServerId: viewModel.presetsByServerId,
        teamNamesByServerId,
    }), [nowMs, query, searchable, viewModel.showMachinesGroupedByServer, viewModel.visibleMachineGroups, viewModel.managedByServerId, viewModel.presetsByServerId, teamNamesByServerId]);

    React.useEffect(() => {
        const selected = collection.sections.flatMap(section => section.rows).find(row => isMachineCollectionRowSelected(selectedKey, row));
        if (selected) recordMachineCollectionVisit({ ...selected, query });
    }, [selectedKey, collection, query]);

    const openMachine = (row: MachineCollectionRow) => {
        recordMachineCollectionVisit({ ...row, query });
        // Beside a detail, switching machines replaces the shown detail instead of stacking history.
        openHref(router, machineCollectionHref(row), rail && onDetailRoute, 'MachineCollectionList.openMachine');
    };

    const renderMachineRow = (row: MachineCollectionRow) => (
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
            onPress={() => openHref(router, MACHINES_THIS_COMPUTER_ROUTE, rail && onDetailRoute, 'MachineCollectionList.thisComputer')}
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
            onPress={() => openHref(router, SETTINGS_ROUTES.machineDefaults, rail && onDetailRoute, 'MachineCollectionList.defaults')}
        />
    );

    const loading = viewModel.isLoadingMachines && total === 0;
    const empty = !loading && total === 0;
    const managedReadFailures = viewModel.visibleMachineGroups.filter(group => {
        const status = viewModel.managedInventory?.entries[group.serverId]?.status;
        return status === 'error' || status === 'denied'
            || (status === 'unsupported' && (viewModel.managedByServerId?.[group.serverId]?.length ?? 0) > 0)
            || viewModel.managedInventory?.accountScopes.get(group.serverId)?.resolution.kind === 'unavailable';
    });
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
    const renderUnreadable = (group: Readonly<{ serverId: string; serverName: string }>, compact: boolean) => {
        // Retry reads the focused Home again; another Home recovers through its own connection.
        const canRetry = group.serverId === viewModel.activeServerId;
        return (
            <Item
                key={`unreadable:${group.serverId}`}
                testID="settings.machines.unreadable"
                title={t('settingsMachines.unreadableTitle', { home: group.serverName })}
                titleLines={0}
                density={compact ? 'compact' : undefined}
                showChevron={false}
                mode="info"
                rightElement={canRetry ? (
                    <RoundButton
                        testID="settings.machines.unreadable.retry"
                        size="small"
                        display="secondary"
                        title={t('common.retry')}
                        onPress={() => fireAndForget(sync.refreshMachines(), { tag: 'MachineCollectionList.retry' })}
                    />
                ) : undefined}
            />
        );
    };
    const noMatches = searchable && query.trim().length > 0 && collection.count === 0;
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
        selectedKey={selectedKey} replacing={rail && onDetailRoute} query={searchable ? query : ''}
        refresh={viewModel.presetInventory.refresh} />) : null;
    const managedReadApprovals = viewModel.visibleMachineGroups.map(group => <ManagedMachineReadApprovalNotice
        key={group.serverId} serverId={group.serverId} entry={viewModel.managedInventory?.entries[group.serverId]}
        testID={`settings.machines.managed.approval.${group.serverId}`} />);

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
            count={loading ? null : total}
            headerAction={<AddMachineMenu options={addOptions} replaceInCollection={onDetailRoute} />}
            search={searchable ? {
                value: query,
                onChangeText: setQuery,
                placeholder: t('settingsMachines.searchPlaceholder'),
                testID: 'settings.machines.rail.search',
            } : null}
        >
            <MachineDraftRow selected={selectedKey === 'machineDraft'} replace={onDetailRoute} />
            {selectedKey?.startsWith('poolDraft:') ? <MachinePoolDraftRow /> : null}
            {defaultsRow}
            {thisComputerRow}
            {renderManagedReadFailures()}
            {managedReadApprovals}
            {loading ? (
                <Item title={t('common.loading')} density="compact" showChevron={false} mode="info" />
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
                            count={section.rows.length}
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
                    ) : section.rows.map(renderMachineRow)}
                </React.Fragment>
            ))}
            <MachinePoolsSection groups={viewModel.visibleMachineGroups} variant="rail" selectedKey={selectedKey} />
            {presetSections}
        </CollectionList>
    );
});

/** Retired resources remain recoverable without rejoining the active Machines list. */
function ArchivedMachineSection(props: Readonly<{
    section: MachineCollectionSection;
    rail: boolean;
    selectedKey: string | null;
    query: string;
    renderRow: (row: MachineCollectionRow) => React.ReactElement;
}>) {
    const [expanded, setExpanded] = React.useState(false);
    const selected = props.section.rows.some(row => isMachineCollectionRowSelected(props.selectedKey, row));
    const disclosure = <ExpandableItem expanded={expanded || selected || props.query.trim().length > 0}
        onExpandedChange={setExpanded} header={state => <Item {...state.headerProps}
            testID={`settings.machines.archived.${props.section.serverId}`}
            title={t('managedCleanup.archiveTitle')} detail={String(props.section.rows.length)}
            density={props.rail ? 'compact' : undefined} showChevron={false} /> }>
        {props.section.rows.map(props.renderRow)}
    </ExpandableItem>;
    return props.rail ? disclosure : <ItemGroup title={props.section.title ?? undefined}>{disclosure}</ItemGroup>;
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
    const { theme } = useUnistyles();
    const router = useRouter();
    const scopeKey = JSON.stringify([props.section.serverId, props.state?.approval]);
    const approval = useActionApprovalContinuation({ scopeKey, serverId: props.section.serverId, onExecuted: () => {} });
    React.useEffect(() => {
        if (props.state?.approval) approval.requestApproval(props.state.approval);
    }, [props.state?.approval, approval.requestApproval]);
    const title = [t('machinePresets.short'), props.section.title].filter(Boolean).join(' · ');
    const newHref = `/settings/machines/presets/new?serverId=${encodeURIComponent(props.section.serverId)}`;
    // The group's own "+" creates a preset (lab `m-presets`); it waits until the list is readable.
    const add = !props.state?.loading && !props.state?.error ? <IconButton testID={`settings.machines.presets.new.${props.section.serverId}`}
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
            title={row.title} subtitle={row.preset.archivedAt !== undefined ? `${audience} · ${t('machinePresets.archived')}` : audience}
            icon={<HappierCollectionListMark><Icon name="stack" color={theme.colors.text.secondary} /></HappierCollectionListMark>}
            density={props.rail ? 'compact' : undefined} selected={props.rail ? isMachineCollectionRowSelected(props.selectedKey, row) : undefined}
            showChevron={!props.rail} pressableStyle={props.rail ? collectionListStyles.row : undefined}
            onPress={() => { recordMachineCollectionVisit({ ...row, query: props.query });
                openHref(router, machineCollectionHref(row), props.replacing, 'MachinePresetCollection.open'); }} />;
            return row.preset.owner.kind === 'team' ? <MachinePresetTeamCollectionRow key={machineCollectionRowKey(row)}
                serverId={row.serverId} teamId={row.preset.owner.teamId} knownName={row.teamName} render={render} /> : render(row.audience);
        })}
        {props.section.rows.length === 0 && !props.state?.error ? (props.state?.loading
            ? <Item testID={`settings.machines.presets.empty.${props.section.serverId}`} title={t('machinePresets.loading')}
                mode="info" density={props.rail ? 'compact' : undefined} showChevron={false} />
            : <EmptyState testID={`settings.machines.presets.empty.${props.section.serverId}`} layout="line"
                title={props.query.trim() ? t('common.noMatches') : t('machinePresets.empty')}
                lineDensity={props.rail ? 'compact' : undefined} lineRowStyle={props.rail ? collectionListStyles.row : undefined} />) : null}
    </>;
    if (!props.rail) return <ItemGroup title={title} action={add}>{rows}</ItemGroup>;
    return <><CollectionListGroupLabel title={title} {...(props.section.rows.length > 0 ? { count: props.section.rows.length } : {})}
        trailing={add} />
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
