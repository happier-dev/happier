import * as React from 'react';
import { resolveMachineKindGlyph } from '@/components/machines/machineKindGlyph';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { MachineWorkingCountsProvider, useMachineWorkingCount, useMachineWorkingTotal } from '@/components/machines/work/machineWorkingCounts';
import {
    AddMachineMenu,
    MachineAddOptionTiles,
    MachineCollectionList,
    MachineHomeUnreadableRow,
    readManagedMachineReadFailures,
} from '@/components/settings/machines/collection/MachineCollectionList';
import { readLastVisitedMachine, recordMachineCollectionVisit } from '@/components/settings/machines/collection/machineCollectionVisit';
import {
    machineCollectionHref,
    machineCollectionRowKey,
    machinePageHref,
    type MachineCollectionRow,
    type MachineCollectionSection,
} from '@/components/settings/machines/collection/machineCollectionModel';
import { useMachineAddOptions } from '@/components/settings/machines/collection/useMachineAddOptions';
import { MACHINES_INDEX_SETTINGS, useMachinesIndexView, type MachinesIndexView } from '@/components/settings/machines/machinesIndexSettings';
import { useMachinesSettingsViewModel } from '@/components/settings/machines/machinesSettingsViewModel';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { MainScreenHeader, type MainScreenSearch } from '@/components/navigation/shell/MainScreenHeader';
import type { PageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineCollection, useMachineCollectionPresenceRows } from '@/components/settings/machines/collection/useMachineCollection';
import { partitionMachineFleetPresence, resolveMachineFleetPresence } from '@/sync/domains/machines/reachability/machineReachability';
import { useReconciledStableRows } from '@/hooks/session/reconcileStableRows';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useDeviceType } from '@/utils/platform/responsive';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { MachineAttentionEntry } from '@/components/machines/attention/collectMachineAttention';
import { useMachineAttention } from '@/sync/domains/machines/resources/useMachineAttention';
import { MachinesNeedsYouList } from '@/components/machines/attention/MachinesNeedsYouList';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { describeFleetDescription, describeFleetTitle, describeMachineAttentionWord, readMachinePublishedResources, selectAttentionSubjects, selectHeadlineReason } from '@/components/machines/summary/machineResourceSentences';
import { MACHINE_CARD_METRICS_HEIGHT_PX, MachineCardBody } from './MachineCardBody';
import { MachineSummaryStrip, machineSummaryMetricTitle } from '@/components/machines/summary/MachineSummaryStrip';
import { useMachineSummaryFreshnessFacts } from '@/components/machines/summary/MachineSummaryFreshnessLine';
import { formatMachineBytes, resolveMachineCoreCount } from '@/components/machines/vitals/machineVitalsPresentation';
import { useMachineSummarySettingValue } from '@/components/machines/summary/useMachineSummarySetting';
import type { MachineSummaryMetric, MachineSummaryStyle } from '@/components/machines/summary/machineSummaryStripModel';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { MachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { useMachineResourceSummary, type MachineResourceAvailability } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { MachinesDashboardArea } from '@/components/machines/widgets/MachinesDashboardArea';
import { MachineAttentionStatedAbove } from '@/components/machines/widgets/machineAttentionStatedAbove';

const NO_ATTENTION_ENTRIES: readonly MachineAttentionEntry[] = [];
const NO_ITEMS: MachineIndexItem[] = [];
const NO_MACHINE_KEYS: readonly Readonly<{ serverId: string; machineId: string }>[] = [];

/** The index offers a search field only once the fleet no longer fits at a glance (as the list column does). */
const SEARCH_THRESHOLD = 8;
const NEEDS_YOU_GROUP = 'needsYou';
/** A machine card's narrowest readable width at normal text size: its name, tag and footer facts. */
const CARD_MIN_WIDTH_PX = 280;
/** The table's narrowest readable width: the machine with where it runs, its work and its presence. */
const LIST_MIN_WIDTH_PX = 360;
/** A metric column holds the strip's line and its figure ("125 GB"). */
const METRIC_COLUMN_WIDTH_PX = 120;
/** Memory's figure turns into its pressure word under load, so its column holds the longest one ("Memoria scarsa") whole. */
const MEMORY_COLUMN_WIDTH_PX = 152;
type MachineIndexItem = MachineCollectionRow & Readonly<{
    key: string;
    sectionKey: string;
    thisComputer: boolean;
    /** What the machine is, from its published host facts ("48 cores · 125 GB"); `null` until it has reported. */
    facts: string | null;
}>;

/**
 * "All machines" (R3, lab `F`/`FC`), the index of both Machines doors: the fleet in one present-tense
 * header, then every machine as a List (table) or a Grid (one same-size card each), the choice
 * remembered on this device. Where the machine list does not stand beside it (phones, narrow
 * Settings), the collection's configuration — defaults, this computer, pools, presets — follows.
 * Until plan 20's summary lands it states presence and work only: no strips, no sentence, no badge.
 */
export function AllMachinesIndex() {
    return (
        <MachineWorkingCountsProvider>
            <AllMachinesIndexBody />
        </MachineWorkingCountsProvider>
    );
}

function AllMachinesIndexBody() {
    const language = usePreferredLanguage();
    const router = useRouter();
    const door = useMachinesDoor();
    const deviceType = useDeviceType();
    const collectionLayout = useHappierCollectionLayout();
    const shellColumnVisible = useAppShellColumn().columnVisible;
    // The machine list stands beside this page in Settings' split layout, or as the shell column in the rail door while
    // that column shows; collapsed, the page is the only list and keeps search, add and configuration (F7).
    const besideList = collectionLayout ? collectionLayout.mode === 'split' : door === 'rail' && shellColumnVisible;
    const viewModel = useMachinesSettingsViewModel();
    const addOptions = useMachineAddOptions(viewModel.visibleMachineGroups);
    const thisComputerMachineId = useThisComputerMachineId();
    const nowMs = Date.now();
    const [view, setView] = useMachinesIndexView();
    // The search survives opening a machine and coming back (phones push the page), like the list column's.
    const [query, setQuery] = React.useState(() => readLastVisitedMachine()?.query ?? '');

    const collection = useMachineCollection({
        groups: viewModel.visibleMachineGroups,
        groupedByHome: viewModel.showMachinesGroupedByServer,
        managedByServerId: viewModel.managedByServerId,
        managedFirstAnswerPending: viewModel.managedFirstAnswerPending,
    });
    // The same groups the list column draws (one list model): Your machines, Created by Happier, Shared
    // with you, each Home. Retired created machines stay in the column's archive, not in the fleet.
    const sections = React.useMemo(() => collection.sections.filter(section => !section.archived), [collection.sections]);
    // What each machine publishes (plan 20): the fleet sentence and Needs you first.
    const attention = useMachineAttention(viewModel.visibleMachineGroups);
    const attentionSubjects = React.useMemo(() => selectAttentionSubjects(attention.entries), [attention.entries]);
    const needsYouSubjectKeys = useReconciledStableRows(attentionSubjects.map(entry => entry.key), String);
    const needsYouKeys = React.useMemo(() => new Set(needsYouSubjectKeys), [needsYouSubjectKeys]);
    const fleetTitle = describeFleetTitle({ subjects: attention.entries, reportingCount: attention.reportingCount });
    const fleetDescription = describeFleetDescription({ subjects: attention.entries, reportingCount: attention.reportingCount, onlineCount: attention.onlineCount, nowMs });
    const openAttention = React.useCallback((entry: MachineAttentionEntry, tab: MachinePageTabParams | null) => {
        const result = runGuardedNavigation(() => router.push(machinePageHref({ door, target: { machineId: entry.machineId, serverId: entry.serverId },
            ...(tab ? { tab } : {}) }) as never));
        if (result !== true) fireAndForget(result, { tag: 'AllMachinesIndex.needsYou' });
    }, [door, router]);
    // Host facts are published resources: read per machine from the store as one string, since the groups carry
    // machine facts only (a resource publication must not rebuild this page; a changed host still shows at once).
    const hostTargetsKey = JSON.stringify(viewModel.visibleMachineGroups.map(group => [group.serverId, group.machines.map(machine => machine.id)]));
    const selectFacts = React.useMemo(() => {
        let last: { machines: unknown; lists: unknown; json: string } | null = null;
        return (state: Parameters<typeof resolveServerScopedMachine>[0]): string => {
            // Re-derived only when machine inventory changes, not on every store write.
            if (last && last.machines === state.machines && last.lists === state.machineListByServerId) return last.json;
            const facts: [string, string][] = [];
            for (const [serverId, machineIds] of JSON.parse(hostTargetsKey) as [string, string[]][]) {
                for (const machineId of machineIds) {
                    const host = readMachinePublishedResources(resolveServerScopedMachine(state, serverId, machineId)?.daemonState)?.host;
                    if (host) facts.push([JSON.stringify([serverId, machineId]), t('machineVitals.header.coresMemory', {
                        cores: resolveMachineCoreCount(host), memory: formatMachineBytes(host.memoryTotalBytes, 'memory'),
                    })]);
                }
            }
            last = { machines: state.machines, lists: state.machineListByServerId, json: JSON.stringify(facts) };
            return last.json;
        };
    // `language`: the facts are localized.
    }, [hostTargetsKey, language]);
    const factsJson = storage(selectFacts);
    const factsByMachine = React.useMemo(() => new Map(JSON.parse(factsJson) as [string, string][]), [factsJson]);
    // Inventory revisions remain current at the store; only changed row facts
    // replace the Collection's item, rather than every item on a heartbeat.
    const answeredItems = useReconciledStableRows(React.useMemo((): MachineIndexItem[] => sections.flatMap(section => section.rows.map(row => ({
        ...row,
        key: machineCollectionRowKey(row),
        sectionKey: section.key,
        thisComputer: row.kind === 'machine' && row.machineId === thisComputerMachineId,
        facts: factsByMachine.get(JSON.stringify([row.serverId, row.kind === 'machine' ? row.machineId : row.enrolledMachineId ?? ''])) ?? null,
    }))), [factsByMachine, sections, thisComputerMachineId]), readKey);
    // The first answer is held whole behind the Collection's loading contract: rows, headline and count land once,
    // together, and a later re-read keeps what is already shown (same first load as the list column).
    const answerPending = (viewModel.isLoadingMachines && answeredItems.length === 0) || collection.firstAnswerPending;
    const [answered, setAnswered] = React.useState(false);
    if (!answerPending && !answered) setAnswered(true);
    const holding = answerPending && !answered;
    const items = useMachineCollectionPresenceRows(holding ? NO_ITEMS : answeredItems);
    const presence = React.useMemo(() => partitionMachineFleetPresence(items, item => item.fleetPresence), [items]);
    // Archive/display ownership does not withdraw a current Machine from its Home's fleet.
    // Only membership contributes to this total, so heartbeats need no second subscription here.
    const fleetCount = React.useMemo(() => {
        const { counts } = partitionMachineFleetPresence(viewModel.visibleMachineGroups.flatMap(group => group.machines
            .map(machine => resolveMachineFleetPresence(group.accountScope, machine))), fact => fact);
        return counts.online + counts.offline + counts.unknown;
    }, [viewModel.visibleMachineGroups]);
    const searchable = items.length > SEARCH_THRESHOLD;
    const normalizedQuery = searchable && !besideList ? query.trim().toLocaleLowerCase() : '';
    // A long fleet keeps its offline machines out of the table until asked for, as the list column folds them
    // (real fleets carry dozens of retired or sleeping machines); a search still reaches every machine.
    const [showOffline, setShowOffline] = React.useState(false);
    const offlineCount = searchable ? presence.counts.offline : 0;
    const offlineKeys = React.useMemo(() => new Set(presence.offline.map(readKey)), [presence]);
    const offlineFoldable = offlineCount > 0 && offlineCount < items.length && !normalizedQuery;
    const hideOffline = offlineFoldable && !showOffline;
    const filter = React.useCallback((item: MachineIndexItem) => (!hideOffline || !offlineKeys.has(item.key)) && (!normalizedQuery
        || item.title.toLocaleLowerCase().includes(normalizedQuery)
        || (item.host?.toLocaleLowerCase().includes(normalizedQuery) ?? false)), [hideOffline, normalizedQuery, offlineKeys]);

    const open = React.useCallback((key: string | null) => {
        const item = key ? items.find(candidate => candidate.key === key) : null;
        if (!item) return;
        recordMachineCollectionVisit({ ...item, query });
        const result = runGuardedNavigation(() => router.push(machineCollectionHref(item, door) as never));
        if (result !== true) fireAndForget(result, { tag: 'AllMachinesIndex.open' });
    }, [door, items, query, router]);
    // The Grid leads with the machines that need you as their own cards (lab `FC`); the List says them above the table.
    const needsYouGrouped = view === 'grid' && needsYouKeys.size > 0;
    const groupAxis = useReconciledStableRows([
        ...(needsYouGrouped ? [{ key: NEEDS_YOU_GROUP, title: t('machineAttention.groups.needsYou') }] : []),
        ...sections.map(section => ({
            key: section.key,
            title: section.title ?? t('allMachines.allMachinesGroup'),
            ...(viewModel.showMachinesGroupedByServer ? { description: describeSectionStatus(section) } : {}),
        })),
    ], group => group.key);
    const groups = React.useMemo(() => ({
        axis: groupAxis,
        groupOf: (item: MachineIndexItem) => needsYouGrouped && item.kind === 'machine' && needsYouKeys.has(JSON.stringify([item.serverId, item.machineId]))
            ? NEEDS_YOU_GROUP : item.sectionKey,
        // A Home without machines keeps its group, saying how it is (signed out, connecting).
        retainEmpty: viewModel.showMachinesGroupedByServer,
    }), [groupAxis, needsYouGrouped, needsYouKeys, viewModel.showMachinesGroupedByServer]);
    const model = useHappierCollection<MachineIndexItem>({
        items,
        keyOf: readKey,
        groups,
        filter,
        openKey: null,
        onOpenChange: open,
    });
    // Only the cards the Collection displays can state a reason above the dashboard.
    // A read/access reason keeps its existing priority over resource attention.
    const cardAttention = React.useMemo(() => {
        const stated = new Map<string, MachineAttentionEntry>();
        if (view !== 'grid') return stated;
        const byMachine = new Map(attentionSubjects.map(entry => [entry.key, entry]));
        for (const section of model.sections) {
            for (const item of section.items) {
                if (item.reason !== null) continue;
                const key = presetMachineKey(item);
                const entry = key === null ? undefined : byMachine.get(key);
                if (entry) stated.set(item.key, entry);
            }
        }
        return stated;
    }, [attentionSubjects, model.sections, view]);
    const cardAttentionEntries = React.useMemo(() => [...cardAttention.values()], [cardAttention]);
    const summarySetting = useMachineSummarySettingValue();
    const anatomy = useMachineIndexAnatomy(view, summarySetting.style, summarySetting.metrics, deviceType === 'phone', cardAttention);
    // An open page keeps its online machines' summaries live (one batched demand for the whole fleet), owned by a
    // leaf so a hide or a window blur withdraws it without redrawing the page.
    const demandKeys = React.useMemo(() => items.flatMap(item => item.online && item.kind === 'machine'
        ? [{ serverId: item.serverId, machineId: item.machineId }] : []), [items]);
    // The header says how current those summaries are; a page that shows none has nothing live to speak for.
    const freshnessKeys = holding || summarySetting.metrics.length === 0 ? NO_MACHINE_KEYS : demandKeys;

    // The main-screen head (owner 11-11): the magnifier opens the search; the "+" and the bar's "+" open one add menu.
    const addOpenerRef = React.useRef<(() => void) | null>(null);
    const addLabel = t('settings.addMachine');
    const addCreate = React.useMemo<PageCreateAction>(() => ({ label: addLabel, testID: 'machines-add', onPress: () => addOpenerRef.current?.() }), [addLabel]);
    const searchPlaceholder = t('settingsMachines.searchPlaceholder');
    const search = React.useMemo<MainScreenSearch>(() => ({ value: query, onChangeText: setQuery, placeholder: searchPlaceholder, testID: 'machines.index.search' }),
        [query, searchPlaceholder]);
    const header = (
        <>
            <AllMachinesHeader
                sentence={holding || needsYouKeys.size > 0 ? null : fleetTitle}
                description={holding ? null : fleetDescription}
                machineCount={holding ? null : fleetCount}
                scopeLabel={viewModel.visibleMachineGroups.map(group => group.serverName).join(' · ')}
                freshnessKeys={freshnessKeys}
                view={view}
                onViewChange={setView}
                addMenu={besideList ? null : <AddMachineMenu options={addOptions} replaceInCollection={false} openerRef={addOpenerRef} />}
                create={besideList || addOptions.length === 0 ? null : addCreate}
                // Beside the machine list the list's own search finds every machine; a second field would repeat it.
                search={searchable && !besideList ? search : null}
                phone={deviceType === 'phone'}
            />
            {/* The list names each reason here; the grid states it in each machine's existing status line. */}
            {view === 'list' ? <MachinesNeedsYouList entries={holding ? NO_ATTENTION_ENTRIES : attention.entries} nowMs={nowMs} onOpen={openAttention} compact={deviceType === 'phone'} testID="machines.index.needs-you" /> : null}
            {/* The table is the page's next section (lab `rm` F): one section gap under what leads, as every
                sheet below a page header has. The phone's list and the grid bring their own group spacing. */}
            {view === 'list' && deviceType !== 'phone' ? <View style={stylesheet.beforeTable} /> : null}
        </>
    );
    // A Home that could not list its machines ends in that fact; an unread created-machine inventory is
    // said by its notice (configuration below, or the list column) — neither is "no machines yet".
    const unreadableGroup = items.length === 0 ? viewModel.visibleMachineGroups.find(group => group.status === 'error') ?? null : null;
    const managedReadFailed = readManagedMachineReadFailures(viewModel).length > 0;
    const empty = normalizedQuery ? (
        <EmptyState testID="machines.index.noMatch" layout="line" title={t('common.noMatches')} />
    ) : unreadableGroup ? (
        <MachineHomeUnreadableRow group={unreadableGroup} compact={false} canRetry={unreadableGroup.serverId === viewModel.activeServerId} />
    ) : managedReadFailed ? null : (
        <View style={stylesheet.empty}>
            <MachineAddOptionTiles options={addOptions.filter((option) => option.id !== 'pool' && option.id !== 'preset')} testIdPrefix="machines.index.add" />
        </View>
    );

    // After the machines, outside their sheet (lab `rm` F leads with Needs you and the table): the person's own
    // dashboard (plan 60 AGW-19), a sheetless section whose cards keep the table's edges (lab `rw` D) and do not repeat
    // what Needs you says; a fleet with no machine has nothing to bind it to. Then, where the machine list does not
    // stand beside the page, the collection's configuration.
    const fleetFirstOnline = presetMachineKey(items.find(item => item.kind === 'machine' && item.online));
    const fleetFirst = presetMachineKey(items.find(item => item.kind === 'machine'));
    const fleetOnline = items.flatMap(item => item.kind === 'machine' && item.online ? [presetMachineKey(item)!] : []).join('\n');
    const fleetPresenceLoaded = viewModel.visibleMachineGroups.every(group => group.status === 'idle');
    const fleet = React.useMemo(() => ({ firstOnline: parsePresetMachineKey(fleetFirstOnline), first: parsePresetMachineKey(fleetFirst),
        onlineKeys: fleetOnline ? fleetOnline.split('\n') : [], presenceLoaded: fleetPresenceLoaded }), [fleetFirst, fleetFirstOnline, fleetOnline, fleetPresenceLoaded]);
    const after = (
        <>
            {items.length > 0 ? (
                <MachineAttentionStatedAbove entries={view === 'list' ? attention.entries : cardAttentionEntries}>
                    <ItemGroup header="none" surface="none" style={stylesheet.afterMachines}>
                        <MachinesDashboardArea fleet={fleet} attention={attention} />
                    </ItemGroup>
                </MachineAttentionStatedAbove>
            ) : null}
            {besideList ? null : <MachineCollectionList variant="configuration" viewModel={viewModel} addOptions={addOptions} />}
        </>
    );

    // The header, the table or grid, then the dashboard and configuration share the page column's edges (lab `F`, `FC`).
    // The page's scroller stands above the Collection, so the table windows its rows in it (`page-virtualized`).
    // The content column sits inside the Collection scope: the column draws no edge and says so after the scope
    // states the page's, so the header text, the table and every section take their own insets from it.
    return (
        <ItemList pageColumn="wide"><CoreCollectionScope renderPageScroller={passThroughPageScroller}>
        <PageContentColumn>
            <Collection<MachineIndexItem>
                testID="machines.index.collection"
                model={model}
                anatomy={anatomy}
                accessibilityLabel={t('allMachines.rowTitle')}
                presentation={view === 'grid' ? 'grid' : 'table'}
                detail="none"
                // The table windows its rows in the page (a fleet is user-sized data); the grid's cards still scroll with
                // the page, every card mounted, since Collection windows only tables and catalog directories in a page.
                scroll={view === 'grid' ? 'page' : 'page-virtualized'}
                minListWidth={LIST_MIN_WIDTH_PX}
                minDetailWidth={LIST_MIN_WIDTH_PX}
                preferredListRatio={1}
                minCardWidth={CARD_MIN_WIDTH_PX}
                header={header}
                loading={answerPending}
                empty={empty}
                {...(offlineFoldable ? { footer: (
                    <SurfaceStateCard testID="machines.index.offline" size="line" kind="empty"
                        title={t('allMachines.offlineListCount', { count: offlineCount })}
                        action={{ testID: 'machines.index.offline-action', label: showOffline ? t('allMachines.hideOffline') : t('allMachines.showOffline'),
                            onPress: () => setShowOffline(value => !value) }} />
                ) } : {})}
            />
        {after}
        </PageContentColumn>
        </CoreCollectionScope></ItemList>
    );
}

/** A machine's preset identity as a stable string, so the dashboard's binding input changes only when the machine does. */
function presetMachineKey(item: MachineIndexItem | undefined): string | null {
    return item?.kind === 'machine' ? JSON.stringify([item.serverId, item.machineId]) : null;
}

function parsePresetMachineKey(key: string | null): Readonly<{ serverId: string; machineId: string }> | null {
    if (key === null) return null;
    const [serverId, machineId] = JSON.parse(key) as [string, string];
    return { serverId, machineId };
}

function readKey(item: MachineIndexItem): string {
    return item.key;
}

/** A Home's group line when several Homes are listed: its machine count and, when not idle, how it is. */
function describeSectionStatus(section: MachineCollectionSection): string {
    const status = section.status === 'signedOut' ? t('server.signedOut')
        : section.status === 'loading' ? t('status.connecting')
            : section.status === 'error' ? t('status.error') : null;
    return [t('settingsMachines.count', { count: section.rows.length }), status].filter(Boolean).join(' · ');
}

/** The page's own scroller already holds the Collection: its page modes draw no second one. */
function passThroughPageScroller(children: React.ReactNode): React.ReactNode {
    return children;
}

/** The fleet in one header: what it is, how many machines and how much work, and List | Grid at the right. */
const AllMachinesHeader = React.memo(function AllMachinesHeader(props: Readonly<{
    /** The fleet in one sentence ("2 machines need a look"), leading the purpose line; `null` while no machine reports. */
    sentence: string | null;
    description: string | null;
    /** `null` during the first load, so the count lands once with its groups. */
    machineCount: number | null;
    scopeLabel: string;
    /** The online machines whose summaries the page shows: the facts line ends in Live or "As of 10:42 · Retry" for them (MPG-11). */
    freshnessKeys: readonly Readonly<{ serverId: string; machineId: string }>[];
    view: MachinesIndexView;
    onViewChange: (next: MachinesIndexView) => void;
    addMenu: React.ReactNode;
    /** The page's add, lent to the phone bar's "+" (the title row's "+" is `addMenu`). */
    create: PageCreateAction | null;
    search: MainScreenSearch | null;
    /** List | Grid stands under the title on a phone (lab `rm` Fp), beside the add on a wide page. */
    phone: boolean;
}>) {
    const language = usePreferredLanguage();
    const { theme } = useUnistyles();
    const working = useMachineWorkingTotal();
    const freshness = useMachineSummaryFreshnessFacts(props.freshnessKeys, 'machines.index.freshness');
    const tabs = React.useMemo(() => [
        { id: 'list' as const, label: t('allMachines.viewList'), icon: <Icon name="list" size={16} color={theme.colors.text.secondary} /> },
        { id: 'grid' as const, label: t('allMachines.viewGrid'), icon: <Icon name="squares-four" size={16} color={theme.colors.text.secondary} /> },
    ], [language, theme.colors.text.secondary]);
    // An empty fleet says nothing about counts (its add section below says what to do) and has nothing to view two ways.
    const emptyFleet = props.machineCount === 0;
    const meta = React.useMemo(() => emptyFleet ? freshness : [
        ...(props.machineCount === null ? [] : [{ key: 'machines', text: t('allMachines.machinesCount', { count: props.machineCount }), testID: 'machines.index.count' }]),
        { key: 'working', text: t('allMachines.sessionsWorking', { count: working }), testID: 'machines.index.working' },
        ...freshness,
    ], [emptyFleet, freshness, language, props.machineCount, working]);
    const viewSwitch = emptyFleet ? null : (
        <SettingAnchor setting={MACHINES_INDEX_SETTINGS.settings.indexView}>
            <SegmentedTabBar<MachinesIndexView>
                role="radiogroup"
                tabs={tabs}
                activeTabId={props.view}
                onSelectTab={props.onViewChange}
                testIDPrefix="machines.index.view"
                accessibilityLabel={t('allMachines.viewLabel')}
                segmentSizing="content"
            />
        </SettingAnchor>
    );
    return (
        <MainScreenHeader
            testID="machines.index.header"
            alwaysShowTitle
            title={t('settings.machines')}
            // The page's generic purpose only stands while the fleet has nothing to say (owner 11-05).
            description={[props.sentence === null ? props.description ?? t('settingsMachines.pageDescription')
                : [props.sentence, props.description].filter(Boolean).join('. '), props.scopeLabel].filter(Boolean).join(' · ')}
            meta={meta}
            search={props.search}
            actions={props.phone ? undefined : viewSwitch}
            create={props.create}
            createTrigger={props.addMenu}
            band={props.phone && viewSwitch ? <View style={stylesheet.phoneViewSwitch}>{viewSwitch}</View> : undefined}
        />
    );
});

/**
 * One anatomy for both views (lab `rm` F, Fp, FC). The table: the machine with what it is after its name
 * ("48 cores · 125 GB"), its work, one cell per shown metric — offline machines keep missing-value marks,
 * while an online refusal says why across its figures. The phone's list: work on the name's line, the strip (or why there is
 * none) beneath. The grid: the card body with its metric tiles.
 */
function useMachineIndexAnatomy(view: MachinesIndexView, style: MachineSummaryStyle, metrics: readonly MachineSummaryMetric[], phone: boolean, cardAttention: ReadonlyMap<string, MachineAttentionEntry>): CollectionAnatomy<MachineIndexItem> {
    const language = usePreferredLanguage();
    const { theme } = useUnistyles();
    return React.useMemo((): CollectionAnatomy<MachineIndexItem> => {
        const description = (item: MachineIndexItem) => {
            const entry = cardAttention.get(item.key);
            return item.reason ?? (entry ? describeMachineAttentionWord(selectHeadlineReason(entry.attention)!) : item.presence);
        };
        return {
        glyph: (item) => <MachineIndexMark item={item} />,
        title: (item) => item.title,
        titleSuffix: (item) => item.facts,
        // The list's second line (phones): the strip, or why the machine shows none.
        byline: (item) => <MachineIndexListLine item={item} style={style} metrics={metrics} />,
        // A phone's list says the work on the name's line, where the table gives it a column. A machine that is not
        // online passes no meta (its byline says its presence), as the table's Work cell gives it to the presence too.
        ...(phone ? { titleMeta: (item: MachineIndexItem) => item.online ? <MachineWorkCell item={item} /> : null } : {}),
        fields: [
            // Offline machines retain one missing-value mark per metric; an online refusal can span the figures.
            { key: 'work', title: t('allMachines.columnWork'), minWidth: 104, priority: 2,
                ...(metrics.length > 0 ? { spanRest: (item: MachineIndexItem) => item.online && item.reason !== null } : {}),
                render: (item) => metrics.length > 0 && (!item.online || item.reason !== null)
                    ? <Text numberOfLines={2} style={stylesheet.quiet}>{item.reason ?? item.presence}</Text> : <MachineWorkCell item={item} /> },
            ...(metrics.length === 0 ? [
                { key: 'status', title: t('allMachines.columnStatus'), minWidth: 200, priority: 1, render: (item: MachineIndexItem) => <MachinePresenceCell item={item} /> },
            ] : metrics.map((metric, index) => ({
                key: metric,
                title: machineSummaryMetricTitle(metric),
                minWidth: metric === 'memory' ? MEMORY_COLUMN_WIDTH_PX : METRIC_COLUMN_WIDTH_PX,
                priority: 1,
                render: (item: MachineIndexItem) => <MachineMetricCell item={item} metric={metric} style={style} first={index === 0} />,
            }))),
        ],
        ...(view === 'grid' ? {
            title: (item: MachineIndexItem) => item.titleParts.name,
            titleSuffix: (item: MachineIndexItem) => [item.titleParts.hint, describeTag(item) ?? item.ownership].filter(Boolean).join(' · ') || null,
            description,
            card: {
                headerRight: (item: MachineIndexItem) => <MachineIndexUpdateAction item={item} />,
                facts: (item: MachineIndexItem) => <MachineWorkCell item={item} offlineLabel={describeWhere(item)} />,
                ...(metrics.length > 0 ? { body: {
                    heightAtNormalText: MACHINE_CARD_METRICS_HEIGHT_PX,
                    render: (item: MachineIndexItem) => <MachineIndexCard item={item} style={style} metrics={metrics} />,
                } } : {}),
            },
        } : {}),
        accessibilityLabel: (item) => [item.title, describeWhere(item), item.facts, view === 'grid' ? description(item) : item.presence].filter(Boolean).join(', '),
        testID: (item) => `machines.index.row.${item.key}`,
        columnTitles: { title: t('allMachines.columnMachine') },
        };
    }, [cardAttention, language, metrics, phone, style, theme.colors.text.secondary, view]);
}

/** The phone list's second line: the machine's strip under its name, or — when it shows none — why. */
const MachineIndexListLine = React.memo(function MachineIndexListLine(props: Readonly<{
    item: MachineIndexItem;
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
}>) {
    const availability = useMachineResourceSummary(machineKeyOf(props.item));
    const quiet = props.metrics.length === 0 ? (props.item.reason ?? props.item.presence) : describeQuiet(props.item, availability);
    return <MachineIndexMeter item={props.item} enabled={props.metrics.length > 0}>
        {quiet !== null ? <Text numberOfLines={1} style={stylesheet.quiet}>{quiet}</Text>
            : <MachineSummaryStrip testID={`machines.index.strip.${props.item.key}`}
                availability={availability} style={props.style} metrics={props.metrics} layout="under" />}
    </MachineIndexMeter>;
});

function machineKeyOf(item: MachineIndexItem): Readonly<{ serverId: string; machineId: string }> {
    return { serverId: item.serverId, machineId: item.kind === 'machine' ? item.machineId : item.enrolledMachineId ?? '' };
}

/** The table, phone line and card anchor live demand to their actual metric band. */
function MachineIndexMeter(props: Readonly<{ item: MachineIndexItem; enabled: boolean; fill?: boolean; children: React.ReactNode }>) {
    const ref = React.useRef<View>(null);
    return <MachineResourceLiveDemand machineKeys={[machineKeyOf(props.item)]} detail="summary"
        enabled={props.enabled && props.item.kind === 'machine' && props.item.online} viewportRef={ref}>
    {measure => <View ref={ref} collapsable={false} onLayout={measure} style={props.fill ? { flex: 1 } : undefined}>
        {props.children}
    </View>}
    </MachineResourceLiveDemand>;
}

/** Why a machine shows no figures: this device cannot read it (why), not online (its presence), or online on a Happier that does not report. */
function describeQuiet(item: MachineIndexItem, availability: MachineResourceAvailability | null): string | null {
    if (item.reason) return item.reason;
    if (!item.online) return item.presence;
    if (availability?.kind === 'monitoring_off') return t('machineVitals.monitoring.modes.off');
    if (availability?.kind === 'not_reported') {
        return availability.reason === 'older_happier' ? t('machineSummary.olderHappier') : t('machineSummary.unsupported');
    }
    return null;
}

/** One metric's cell: its figure, an offline missing-value mark, or the first cell's online refusal. */
const MachineMetricCell = React.memo(function MachineMetricCell(props: Readonly<{
    item: MachineIndexItem;
    metric: MachineSummaryMetric;
    style: MachineSummaryStyle;
    first: boolean;
}>) {
    const availability = useMachineResourceSummary(machineKeyOf(props.item));
    const quiet = describeQuiet(props.item, availability);
    // Why there are no figures may take a second line where few columns remain; it is never cut mid-cause.
    const content = !props.item.online ? <Text style={stylesheet.quiet}>—</Text>
        : quiet !== null ? (props.first ? <Text numberOfLines={2} style={stylesheet.quiet}>{quiet}</Text> : null)
        : <MachineSummaryStrip testID={`machines.index.metric.${props.item.key}.${props.metric}`}
            availability={availability} style={props.style} metrics={[props.metric]} layout="cells" />;
    return props.first ? <MachineIndexMeter item={props.item} enabled>{content}</MachineIndexMeter> : content;
});

/** Where it runs, or whose it is: "macOS", "Ben's machine". */
function describeWhere(item: MachineIndexItem): string | null {
    return item.ownership ?? (item.platformLabel || null);
}

function describeTag(item: MachineIndexItem): string | null {
    if (item.thisComputer) return t('settingsMachines.thisComputerTitle');
    return null;
}

const MachineIndexMark = React.memo(function MachineIndexMark(props: Readonly<{ item: MachineIndexItem }>) {
    const { theme } = useUnistyles();
    return <Icon name={resolveMachineKindGlyph({ isThisComputer: props.item.thisComputer, platform: props.item.platform })} size={20} color={theme.colors.text.secondary} />;
});

/** "3 working" (count in ink) or a quiet "No work"; a machine that is not online says it in its presence. */
const MachineWorkCell = React.memo(function MachineWorkCell(props: Readonly<{ item: MachineIndexItem; offlineLabel?: string | null }>) {
    const { item } = props;
    const count = useMachineWorkingCount(item.kind === 'machine' ? { serverId: item.serverId, machineId: item.machineId } : { serverId: item.serverId, machineId: '' });
    if (!item.online && count === 0) return props.offlineLabel ? <Text style={stylesheet.quiet}>{props.offlineLabel}</Text> : null;
    return (
        <Text numberOfLines={1} style={count > 0 ? stylesheet.work : stylesheet.quiet} testID={`machines.index.work.${item.key}`}>
            {count > 0 ? t('machineDetailPage.work.working', { count }) : t('machineDetailPage.work.none')}
        </Text>
    );
});

const MachinePresenceCell = React.memo(function MachinePresenceCell(props: Readonly<{ item: MachineIndexItem }>) {
    const { theme } = useUnistyles();
    const { item } = props;
    return (
        <View style={stylesheet.presence}>
            {item.kind === 'machine' && item.status !== 'unknown' ? (
                <StatusDot color={item.online ? theme.colors.status.connected : theme.colors.status.disconnected} />
            ) : null}
            <Text numberOfLines={1} style={stylesheet.quiet}>{item.reason ?? item.presence}</Text>
        </View>
    );
});

/** Only the Machine's metric band is domain-owned; Collection draws identity, presence, facts and controls. */
const MachineIndexCard = React.memo(function MachineIndexCard(props: Readonly<{
    item: MachineIndexItem;
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
}>) {
    const { item } = props;
    const availability = useMachineResourceSummary(machineKeyOf(item));
    // A machine that does not report says why where its tiles stand: update your own, ask the owner of a shared one.
    const notReported = item.online && availability?.kind === 'not_reported';
    // A machine that is not online has no readings: its line says why, and its band stays empty (not three bare labels).
    const tiles = props.metrics.length === 0 ? undefined : !item.online ? <View /> : notReported ? (
        <Text numberOfLines={2} style={stylesheet.cardQuiet}>
            {item.ownerName ? t('machineSummary.askOwnerToUpdate', { owner: item.ownerName }) : t('machineSummary.updateToSee', { machine: item.title })}
        </Text>
    ) : (
        <MachineSummaryStrip availability={availability} style={props.style} metrics={props.metrics} layout="tiles" />
    );
    return (
        <MachineIndexMeter item={item} enabled={props.metrics.length > 0} fill>
            <MachineCardBody
                testID={`machines.index.card.${item.key}`}
                tiles={tiles}
            />
        </MachineIndexMeter>
    );
});

/** Update keeps its own target in the shared header. */
const MachineIndexUpdateAction = React.memo(function MachineIndexUpdateAction(props: Readonly<{ item: MachineIndexItem }>) {
    const router = useRouter();
    const availability = useMachineResourceSummary(machineKeyOf(props.item));
    if (!(props.item.online && availability?.kind === 'not_reported' && !props.item.ownerName)) return null;
    return (
        <RoundButton testID={`machines.index.card.${props.item.key}.update`} size="small" display="secondary" title={t('machineSummary.update')}
            onPress={() => router.push(UPDATES_ROUTE as never)} />
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    // The dashboard follows the machines as the page's next section: one section gap below the table or grid.
    afterMachines: {
        paddingTop: PAGE_LIST_METRICS.sectionGapPx,
    },
    beforeTable: {
        height: PAGE_LIST_METRICS.sectionGapPx,
    },
    phoneViewSwitch: {
        alignSelf: 'flex-start',
    },
    empty: {
        paddingTop: theme.space.s8,
    },
    work: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.primary,
    },
    quiet: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    cardQuiet: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s16,
    },
    presence: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minWidth: 0,
    },
}));
