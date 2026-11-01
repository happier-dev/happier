import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
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
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
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
import { useMachineCollection } from '@/components/settings/machines/collection/useMachineCollection';
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
import { describeFleetDescription, describeFleetTitle, readMachinePublishedResources, selectAttentionSubjects } from '@/components/machines/summary/machineResourceSentences';
import { MACHINE_CARD_BODY_HEIGHT_PX, MACHINE_CARD_BODY_WITH_TILES_HEIGHT_PX, MachineCardBody } from './MachineCardBody';
import { MachineSummaryStrip, machineSummaryMetricTitle } from '@/components/machines/summary/MachineSummaryStrip';
import { formatMachineBytes, resolveMachineCoreCount } from '@/components/machines/vitals/machineVitalsPresentation';
import { useMachineSummarySettingValue } from '@/components/machines/summary/useMachineSummarySetting';
import type { MachineSummaryMetric, MachineSummaryStyle } from '@/components/machines/summary/machineSummaryStripModel';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useMachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { useMachineResourceSummary, type MachineResourceAvailability } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { MachinesDashboardArea } from '@/components/machines/widgets/MachinesDashboardArea';
import { MachineAttentionStatedAbove } from '@/components/machines/widgets/machineAttentionStatedAbove';

const NO_ATTENTION_ENTRIES: readonly MachineAttentionEntry[] = [];
const NO_ITEMS: MachineIndexItem[] = [];

/** The index offers a search field only once the fleet no longer fits at a glance (as the list column does). */
const SEARCH_THRESHOLD = 8;
const NEEDS_YOU_GROUP = 'needsYou';
/** A machine card's narrowest readable width at normal text size: its name, tag and footer facts. */
const CARD_MIN_WIDTH_PX = 280;
/** The table's narrowest readable width: the machine with where it runs, its work and its presence. */
const LIST_MIN_WIDTH_PX = 360;
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
 * Settings), the collection's configuration — defaults, this computer, pools, recipes — follows.
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
    // The machine list stands beside this page in Settings' split layout, or as the shell column in the rail door.
    const besideList = collectionLayout ? collectionLayout.mode === 'split' : door === 'rail' && deviceType !== 'phone';
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
    const needsYouSubjectKeys = useReconciledStableRows(selectAttentionSubjects(attention.entries).map(entry => entry.key), String);
    const needsYouKeys = React.useMemo(() => new Set(needsYouSubjectKeys), [needsYouSubjectKeys]);
    const fleetTitle = describeFleetTitle({ subjects: attention.entries, reportingCount: attention.reportingCount });
    const fleetDescription = describeFleetDescription({ subjects: attention.entries, reportingCount: attention.reportingCount, onlineCount: attention.onlineCount, nowMs });
    const openAttention = React.useCallback((entry: MachineAttentionEntry, tab: MachinePageTabParams | null) => {
        const result = runGuardedNavigation(() => router.push(machinePageHref({ door, target: { machineId: entry.machineId, serverId: entry.serverId },
            ...(tab ? { tab } : {}) }) as never));
        if (result !== true) fireAndForget(result, { tag: 'AllMachinesIndex.needsYou' });
    }, [door, router]);
    const factsByMachine = React.useMemo(() => {
        const facts = new Map<string, string>();
        for (const group of viewModel.visibleMachineGroups) {
            for (const machine of group.machines) {
                const host = readMachinePublishedResources(machine.daemonState)?.host;
                if (host) facts.set(JSON.stringify([group.serverId, machine.id]), t('machineVitals.header.coresMemory', {
                    cores: resolveMachineCoreCount(host), memory: formatMachineBytes(host.memoryTotalBytes, 'memory'),
                }));
            }
        }
        return facts;
    }, [language, viewModel.visibleMachineGroups]);
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
    const items = holding ? NO_ITEMS : answeredItems;
    const searchable = items.length > SEARCH_THRESHOLD;
    const normalizedQuery = searchable && !besideList ? query.trim().toLocaleLowerCase() : '';
    // A long fleet keeps its offline machines out of the table until asked for, as the list column folds them
    // (real fleets carry dozens of retired or sleeping machines); a search still reaches every machine.
    const [showOffline, setShowOffline] = React.useState(false);
    const offlineCount = React.useMemo(() => searchable ? items.filter(item => item.status === 'offline').length : 0, [items, searchable]);
    const offlineFoldable = offlineCount > 0 && offlineCount < items.length && !normalizedQuery;
    const hideOffline = offlineFoldable && !showOffline;
    const filter = React.useCallback((item: MachineIndexItem) => (!hideOffline || item.status !== 'offline') && (!normalizedQuery
        || item.title.toLocaleLowerCase().includes(normalizedQuery)
        || (item.host?.toLocaleLowerCase().includes(normalizedQuery) ?? false)), [hideOffline, normalizedQuery]);

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
    const summarySetting = useMachineSummarySettingValue();
    const anatomy = useMachineIndexAnatomy(view, summarySetting.style, summarySetting.metrics, deviceType === 'phone');
    // An open page keeps its online machines' summaries live (one batched demand for the whole fleet).
    const demandKeys = React.useMemo(() => items.flatMap(item => item.online && item.kind === 'machine'
        ? [{ serverId: item.serverId, machineId: item.machineId }] : []), [items]);
    useMachineResourceLiveDemand(demandKeys, { detail: 'summary', enabled: summarySetting.metrics.length > 0 });

    const header = (
        <>
            <AllMachinesHeader
                title={holding ? null : fleetTitle}
                description={holding ? null : fleetDescription}
                machineCount={holding ? null : items.length}
                view={view}
                onViewChange={setView}
                addMenu={besideList ? null : <AddMachineMenu options={addOptions} replaceInCollection={false} />}
                phone={deviceType === 'phone'}
            />
            {/* What needs you leads, once (plan 60 D5: the dashboard no longer repeats it); the Grid says it as its own cards. */}
            {view === 'list' ? <MachinesNeedsYouList entries={holding ? NO_ATTENTION_ENTRIES : attention.entries} nowMs={nowMs} onOpen={openAttention} compact={deviceType === 'phone'} testID="machines.index.needs-you" /> : null}
            {/* Beside the machine list the list's own search finds every machine; a second field would repeat it. */}
            {searchable && !besideList ? (
                <CompactSearchField
                    testID="machines.index.search"
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('settingsMachines.searchPlaceholder')}
                    placement="page"
                />
            ) : null}
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
                <MachineAttentionStatedAbove entries={view === 'list' ? attention.entries : NO_ATTENTION_ENTRIES}>
                    <ItemGroup header="none" surface="none" style={stylesheet.afterMachines}>
                        <MachinesDashboardArea fleet={fleet} attention={attention} />
                    </ItemGroup>
                </MachineAttentionStatedAbove>
            ) : null}
            {besideList ? null : <MachineCollectionList variant="configuration" viewModel={viewModel} addOptions={addOptions} />}
        </>
    );

    return (
        <IndexPageAfterContext.Provider value={after}>
        <CoreCollectionScope renderPageScroller={renderIndexPageScroller}>
            <Collection<MachineIndexItem>
                testID="machines.index.collection"
                model={model}
                anatomy={anatomy}
                accessibilityLabel={t('allMachines.rowTitle')}
                presentation={view === 'grid' ? 'grid' : 'table'}
                detail="none"
                scroll="page"
                minListWidth={LIST_MIN_WIDTH_PX}
                minDetailWidth={LIST_MIN_WIDTH_PX}
                preferredListRatio={1}
                minCardWidth={CARD_MIN_WIDTH_PX}
                header={header}
                loading={answerPending}
                empty={empty}
                {...(offlineFoldable ? { footer: (
                    <SurfaceStateCard testID="machines.index.offline" size="line" kind="empty"
                        title={t('allMachines.offlineHidden', { count: offlineCount })}
                        action={{ testID: 'machines.index.offline-action', label: showOffline ? t('allMachines.hideOffline') : t('allMachines.showOffline'),
                            onPress: () => setShowOffline(value => !value) }} />
                ) } : {})}
            />
        </CoreCollectionScope>
        </IndexPageAfterContext.Provider>
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

/** What the page draws after the collection, read by the page scroller (a stable render, so the host never churns). */
const IndexPageAfterContext = React.createContext<React.ReactNode>(null);

function IndexPageAfter() {
    return <>{React.useContext(IndexPageAfterContext)}</>;
}

function renderIndexPageScroller(children: React.ReactNode): React.ReactNode {
    // The header, the table or grid, then the dashboard and configuration share the page column's edges (lab `F`, `FC`).
    return <ItemList pageColumn="wide"><PageContentColumn>{children}<IndexPageAfter /></PageContentColumn></ItemList>;
}

/** The fleet in one header: what it is, how many machines and how much work, and List | Grid at the right. */
const AllMachinesHeader = React.memo(function AllMachinesHeader(props: Readonly<{
    /** The fleet in one sentence ("2 machines need a look"); `null` while no machine reports, keeping "Machines". */
    title: string | null;
    description: string | null;
    /** `null` during the first load, so the count lands once with its groups. */
    machineCount: number | null;
    view: MachinesIndexView;
    onViewChange: (next: MachinesIndexView) => void;
    addMenu: React.ReactNode;
    /** A phone folds header actions into the navigation bar; List | Grid stays in the page, under the sentence (lab `rm` Fp). */
    phone: boolean;
}>) {
    const language = usePreferredLanguage();
    const { theme } = useUnistyles();
    const working = useMachineWorkingTotal();
    const tabs = React.useMemo(() => [
        { id: 'list' as const, label: t('allMachines.viewList'), icon: <Icon name="list" size={16} color={theme.colors.text.secondary} /> },
        { id: 'grid' as const, label: t('allMachines.viewGrid'), icon: <Icon name="squares-four" size={16} color={theme.colors.text.secondary} /> },
    ], [language, theme.colors.text.secondary]);
    const meta = React.useMemo(() => [
        ...(props.machineCount === null ? [] : [{ key: 'machines', text: t('allMachines.machinesCount', { count: props.machineCount }), testID: 'machines.index.count' }]),
        { key: 'working', text: t('allMachines.sessionsWorking', { count: working }), testID: 'machines.index.working' },
    ], [language, props.machineCount, working]);
    const viewSwitch = (
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
        <>
            <PageHeader
                testID="machines.index.header"
                alwaysShowTitle
                titleProminence="hero"
                title={props.title ?? t('settings.machines')}
                // Under the fleet sentence the page's generic purpose would read as a non sequitur: it only stands under "Machines".
                description={props.description ?? (props.title === null ? t('settingsMachines.pageDescription') : undefined)}
                meta={meta}
                actions={props.phone ? props.addMenu : (
                    <View style={stylesheet.headerActions}>
                        {viewSwitch}
                        {props.addMenu}
                    </View>
                )}
            />
            {props.phone ? (
                <ItemGroup header="none" surface="none">
                    <View style={stylesheet.phoneViewSwitch}>{viewSwitch}</View>
                </ItemGroup>
            ) : null}
        </>
    );
});

/**
 * One anatomy for both views (lab `rm` F, Fp, FC). The table: the machine with what it is after its name
 * ("48 cores · 125 GB"), its work, one cell per shown metric — a machine that reports nothing says why once,
 * across where its figures would stand. The phone's list: work on the name's line, the strip (or why there is
 * none) beneath. The grid: the card body with its metric tiles.
 */
function useMachineIndexAnatomy(view: MachinesIndexView, style: MachineSummaryStyle, metrics: readonly MachineSummaryMetric[], phone: boolean): CollectionAnatomy<MachineIndexItem> {
    const language = usePreferredLanguage();
    const { theme } = useUnistyles();
    return React.useMemo((): CollectionAnatomy<MachineIndexItem> => ({
        glyph: (item) => <MachineIndexMark item={item} />,
        title: (item) => item.title,
        titleSuffix: (item) => item.facts,
        // The list's second line (phones): the strip, or why the machine shows none.
        byline: (item) => <MachineIndexListLine item={item} style={style} metrics={metrics} />,
        // A phone's list says the work on the name's line, where the table gives it a column.
        ...(phone ? { titleMeta: (item: MachineIndexItem) => <MachineWorkCell item={item} /> } : {}),
        fields: [
            { key: 'work', title: t('allMachines.columnWork'), minWidth: 104, priority: 2, render: (item) => <MachineWorkCell item={item} /> },
            ...(metrics.length === 0 ? [
                { key: 'status', title: t('allMachines.columnStatus'), minWidth: 200, priority: 1, render: (item: MachineIndexItem) => <MachinePresenceCell item={item} /> },
            ] : metrics.map((metric, index) => ({
                key: metric,
                title: machineSummaryMetricTitle(metric),
                minWidth: 120,
                priority: 1,
                // A machine that is not online says why once, across where its figures would stand.
                ...(index === 0 ? { spanRest: (item: MachineIndexItem) => !item.online || item.reason !== null } : {}),
                render: (item: MachineIndexItem) => <MachineMetricCell item={item} metric={metric} style={style} first={index === 0} />,
            }))),
        ],
        ...(view === 'grid' ? {
            cardContent: {
                height: metrics.length > 0 ? MACHINE_CARD_BODY_WITH_TILES_HEIGHT_PX : MACHINE_CARD_BODY_HEIGHT_PX,
                // The body draws its footer (work, chevron); Update stands over it as its own target, outside the card's.
                ownsFooter: true,
                render: (item: MachineIndexItem) => <MachineIndexCard item={item} style={style} metrics={metrics} />,
            },
            action: (item: MachineIndexItem) => <MachineIndexUpdateAction item={item} />,
        } : {}),
        accessibilityLabel: (item) => [item.title, describeWhere(item), item.facts, item.presence].filter(Boolean).join(', '),
        testID: (item) => `machines.index.row.${item.key}`,
        columnTitles: { title: t('allMachines.columnMachine') },
    }), [language, metrics, phone, style, theme.colors.text.secondary, view]);
}

/** The phone list's second line: the machine's strip under its name, or — when it shows none — why. */
const MachineIndexListLine = React.memo(function MachineIndexListLine(props: Readonly<{
    item: MachineIndexItem;
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
}>) {
    const availability = useMachineResourceSummary(machineKeyOf(props.item));
    const quiet = props.metrics.length === 0 ? (props.item.reason ?? props.item.presence) : describeQuiet(props.item, availability);
    if (quiet !== null) return <Text numberOfLines={1} style={stylesheet.quiet}>{quiet}</Text>;
    return <MachineSummaryStrip testID={`machines.index.strip.${props.item.key}`}
        availability={availability} style={props.style} metrics={props.metrics} layout="under" />;
});

function machineKeyOf(item: MachineIndexItem): Readonly<{ serverId: string; machineId: string }> {
    return { serverId: item.serverId, machineId: item.kind === 'machine' ? item.machineId : item.enrolledMachineId ?? '' };
}

/** Why a machine shows no figures: not online (its presence), or online on a Happier that does not report. */
function describeQuiet(item: MachineIndexItem, availability: MachineResourceAvailability | null): string | null {
    if (!item.online) return item.reason ?? item.presence;
    if (availability?.kind === 'not_reported') {
        return availability.reason === 'older_happier' ? t('machineSummary.olderHappier') : t('machineSummary.unsupported');
    }
    return null;
}

/** One metric's cell: the strip for that metric with its figure, or — in the first cell — why there is none. */
const MachineMetricCell = React.memo(function MachineMetricCell(props: Readonly<{
    item: MachineIndexItem;
    metric: MachineSummaryMetric;
    style: MachineSummaryStyle;
    first: boolean;
}>) {
    const availability = useMachineResourceSummary(machineKeyOf(props.item));
    const quiet = describeQuiet(props.item, availability);
    if (quiet !== null) return props.first ? <Text numberOfLines={1} style={stylesheet.quiet}>{quiet}</Text> : null;
    return <MachineSummaryStrip testID={`machines.index.metric.${props.item.key}.${props.metric}`}
        availability={availability} style={props.style} metrics={[props.metric]} layout="cells" />;
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
    return <Icon name={props.item.thisComputer ? 'laptop' : 'desktop'} size={20} color={theme.colors.text.secondary} />;
});

/** "3 working" (count in ink) or a quiet "No work"; a machine that is not online says it in its presence. */
const MachineWorkCell = React.memo(function MachineWorkCell(props: Readonly<{ item: MachineIndexItem }>) {
    const { item } = props;
    const count = useMachineWorkingCount(item.kind === 'machine' ? { serverId: item.serverId, machineId: item.machineId } : { serverId: item.serverId, machineId: '' });
    if (!item.online && count === 0) return null;
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

/** The grid's card: the one machine card body, its metric tiles, and work on the left of its footer. */
const MachineIndexCard = React.memo(function MachineIndexCard(props: Readonly<{
    item: MachineIndexItem;
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
}>) {
    const { item } = props;
    const count = useMachineWorkingCount(item.kind === 'machine' ? { serverId: item.serverId, machineId: item.machineId } : { serverId: item.serverId, machineId: '' });
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
    // Where Update will stand over the footer, the body leaves its place empty instead of drawing the chevron.
    const updateAction = notReported && !item.ownerName ? <View style={stylesheet.updatePlace} /> : undefined;
    const work = item.online || count > 0
        ? (count > 0 ? t('machineDetailPage.work.working', { count }) : t('machineDetailPage.work.none'))
        : describeWhere(item);
    return (
        <MachineCardBody
            testID={`machines.index.card.${item.key}`}
            mark={<MachineIndexMark item={item} />}
            // The name without its disambiguator, which stands whole beside it: a long name shortens, the suffix never does.
            name={item.titleParts.name}
            tag={[item.titleParts.hint, describeTag(item) ?? item.ownership].filter(Boolean).join(' · ') || null}
            line={item.reason ?? item.presence}
            tiles={tiles}
            footerLeft={work}
            action={updateAction}
        />
    );
});

/** A card's Update for an own machine on a Happier that does not report: the collection's footer action, a target of its own. */
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
    updatePlace: {
        width: 72,
        height: 28,
    },
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
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
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
