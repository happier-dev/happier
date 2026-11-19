import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionsList } from '@/components/sessions/shell/SessionsList';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CollectionList, CollectionListGroupLabel, CollectionNavigationRow, CollectionRowOrder, CollectionRows, CollectionSkeletonRows, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { HomeReachabilityGate, useActiveHomeUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { AccountTriggersSection, useAccountWorkflowEditor } from '@/components/workflows/triggers/AccountTriggersSection';
import { AccountWorkflowRowAnchor, isAccountWorkflowOff, isAccountWorkflowReviewRequired,
    type AccountWorkflowLibraryRow } from '@/components/workflows/library/AccountWorkflowRowAnchor';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { useWorkflowLibraryView, type WorkflowLibraryViewController } from '@/components/workflows/library/useWorkflowLibraryView';
import { useWorkflowLibrarySpaceHeader } from '@/components/workflows/library/useWorkflowLibrarySpaceHeader';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '@/components/workflows/presentation/workflowProblemPresentation';

import { WorkflowsColumnActions } from './WorkflowsColumnActions';
import { WorkflowColumnRow } from './WorkflowColumnRow';
import type { WorkflowLibraryItem } from '../library/workflowLibraryCells';
import { WorkflowsPhonePage, type WorkflowsColumnView } from './WorkflowsPhonePage';
import { WorkflowsColumnCreationRefContext, WorkflowsColumnHeadsPageContext, WorkflowsColumnOwnsCreationContext } from './workflowsColumnCreation';
import { WorkflowsLibraryHeaderActions } from '../library/WorkflowsLibraryHeaderActions';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { NearViewportWindow } from '@/components/widgets/NearViewportWindow';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { WorkflowBuiltinMark } from '../presentation/WorkflowBuiltinMark';
import { useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { collectionSpaceSettingRefs } from '@/components/settings/session/collectionSpaceSettings';
import { readOpenWorkflowDefinition } from './workflowsColumnModel';
import { WorkflowLibraryFreshness } from '../library/WorkflowLibraryFreshness';
import { isWorkflowEventsPath, useWorkflowsColumnEvents, WorkflowsColumnEventsFilters, WorkflowsColumnEventsListening, WorkflowsColumnEventsRows } from '../events/WorkflowsColumnEvents';
import { WORKFLOWS_EVENTS_ROUTE } from '../workflowsRoutes';


function isRunPath(pathname: string): boolean {
    return /^\/workflows\/runs(?:\/|$)/.test(pathname);
}

function readPathView(pathname: string): WorkflowsColumnView {
    return isRunPath(pathname) ? 'runs' : isWorkflowEventsPath(pathname) ? 'events' : 'definitions';
}

/** Definitions and the canonical Sessions list's Runs view share the destination's column. */
export const WorkflowsColumn = React.memo(function WorkflowsColumn(props: Readonly<{ surface?: 'plane' | 'page'; definitionsContent?: React.ReactNode }>) {
    const access = useWorkflowsDestinationAccess();
    // On a phone the home's header actions would either fold into a second overflow of raw buttons
    // (navigation shows the title) or stack three buttons under the purpose line (a phone-sized web
    // window); the column's own "+" menu (lab `nav-N1m` rows, P1's one way to add) carries creation instead.
    const titleChrome = useNavigationTitleChromeShowsTitle();
    const phone = useViewportClass() === 'compact';
    const ownsCreation = (titleChrome || phone) && props.definitionsContent !== undefined;
    // A page with no navigation bar over it opens on its name, with the actions on the name's line, then the
    // switch, in both views (FIN-DESIGN-REVIEW L6). Under a native header the bar already carries the name.
    const headsPage = !titleChrome && props.definitionsContent !== undefined;
    const creationRef = React.useRef<import('@/keyboard/focusReturn').FocusReturnTarget>(null);
    const setCreationRef = React.useCallback<NonNullable<React.ComponentProps<typeof WorkflowsLibraryHeaderActions>['controlRef']>>(
        target => { creationRef.current = target; }, []);
    const pathname = usePathname();
    const params = useGlobalSearchParams<{ trigger?: string }>();
    const [view, setView] = React.useState<WorkflowsColumnView>(() => readPathView(pathname));
    const filtersRequested = useSettingRevealRequested([collectionSpaceSettingRefs('workflow').filters]);
    React.useEffect(() => {
        if (filtersRequested) setView('definitions');
    }, [filtersRequested]);
    React.useEffect(() => {
        if (params.trigger) setView('definitions');
        else if (isRunPath(pathname)) setView('runs');
        else if (isWorkflowEventsPath(pathname)) setView('events');
        else if (readOpenWorkflowDefinition(pathname)) setView('definitions');
    }, [pathname, params.trigger]);
    // As the page the switch is a row of its own on the sheets' edge; in the column it is the compact icon
    // switch in the band under the title (WorkflowsColumnList), never in the title row.
    // With no navigation chrome above it (a phone browser, an installed web app) the page's name leads and clears the
    // device's top edge itself, the switch under it; under a native header the switch only needs the page's own breathing room.
    const safeAreaTop = useChromeSafeAreaInsets().top;
    const viewTabs = <View style={[styles.views, styles.viewsOnPage, headsPage ? styles.viewsUnderPageTitle : { paddingTop: HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx + (titleChrome ? 0 : safeAreaTop) }]}>
            <View style={styles.viewTabs}>
                <SegmentedTabBar<WorkflowsColumnView>
                testIDPrefix="workflows-column:view"
                accessibilityLabel={t('workflows.tabsAccessibility.savedRuns')}
                tabs={[
                    { id: 'definitions', label: t('workflows.title') },
                    { id: 'runs', label: t('workflows.tabs.runs') },
                    { id: 'events', label: t('workflows.tabs.events') },
                ]}
                activeTabId={view}
                onSelectTab={setView}
                segmentSizing="equal"
                />
            </View>
            {props.definitionsContent === undefined ? null : <WorkflowsColumnActions canCreate={ownsCreation} />}
        </View>;
    // Without a shell column, Definitions is the full home, not a second compact navigation list.
    // The same view owner still reaches Runs; the home carries its own page identity, actions and spaces.
    if (props.definitionsContent !== undefined && access.kind === 'workflows' && headsPage && phone) {
        // A phone's main screen: the main-screen head owns the title (the library's space), search and "+" (owner 11-11).
        return <WorkflowsColumnCreationRefContext.Provider value={creationRef}>
            <WorkflowsColumnOwnsCreationContext.Provider value={ownsCreation}>
                <WorkflowsColumnHeadsPageContext.Provider value={headsPage}>
                    <WorkflowsPhonePage view={view} onSelectView={setView} ownsCreation={ownsCreation} pathname={pathname}
                        definitionsContent={props.definitionsContent} />
                </WorkflowsColumnHeadsPageContext.Provider>
            </WorkflowsColumnOwnsCreationContext.Provider>
        </WorkflowsColumnCreationRefContext.Provider>;
    }
    if (props.definitionsContent !== undefined && access.kind === 'workflows') {
        return <WorkflowsColumnCreationRefContext.Provider value={creationRef}><View testID="workflows-column" style={styles.column}>
            {headsPage ? (
                // The page's name, then the switch, on the library's own wide column, in both views (FIN-DESIGN-REVIEW L6).
                <ListPresentationProvider value="page">
                    <PageFrame column="wide" content="column" style={styles.pageHead}>
                        <View testID="workflows-column:header" style={{ paddingTop: safeAreaTop }}>
                            <PageHeader title={t('workflows.title')} description={t('workflows.destination.description')}
                                actions={<WorkflowsLibraryHeaderActions secondary={!ownsCreation} controlRef={setCreationRef} />} />
                        </View>
                        {viewTabs}
                    </PageFrame>
                </ListPresentationProvider>
            ) : viewTabs}
            {/* Both views stay built once shown and the switch only presents one: a switch never rebuilds a list. */}
            <RetainedPanelSurface isActive={view === 'definitions'} hiddenMode="activity" testID="workflows-column:definitions">
                <WorkflowsColumnOwnsCreationContext.Provider value={ownsCreation}>
                    <WorkflowsColumnHeadsPageContext.Provider value={headsPage}>{props.definitionsContent}</WorkflowsColumnHeadsPageContext.Provider>
                </WorkflowsColumnOwnsCreationContext.Provider>
            </RetainedPanelSurface>
            <RetainedPanelSurface isActive={view === 'runs'} hiddenMode="activity" testID="workflows-column:runs">
                {headsPage
                    // Runs sit in the same wide column as the page's name and switch above them.
                    ? <PageFrame column="wide" content="column" style={styles.pageRuns}><SessionsList fixedShow="runs" pathname={pathname} /></PageFrame>
                    : <SessionsList fixedShow="runs" pathname={pathname} />}
            </RetainedPanelSurface>
            <RetainedPanelSurface isActive={view === 'events'} hiddenMode="activity" testID="workflows-column:events">
                <WorkflowsColumnEventsPage active={view === 'events'} />
            </RetainedPanelSurface>
        </View></WorkflowsColumnCreationRefContext.Provider>;
    }
    const headerAction = access.kind === 'workflows' ? <WorkflowsColumnActions canCreate /> : null;
    if (access.kind === 'workflows') {
        return <View testID="workflows-column" style={styles.column}>
            <WorkflowsColumnList surface={props.surface ?? 'plane'} view={view} onSelectView={setView} headerAction={headerAction} pathname={pathname} />
        </View>;
    }
    return <View testID="workflows-column" style={styles.column}>
        <CollectionList
            testID="workflows-column:list"
            surface={props.surface ?? 'plane'}
            title={t('workflows.title')}
            headerAction={headerAction}
        />
    </View>;
});

/**
 * The column's one list (R9, R8-7): Definitions and Runs switch inside the same list and header, so the
 * switch's thumb glides and nothing above it moves: it lives in the band under the title in both views. Definitions carry the saved-space title, strip and
 * condition editor over the one Workflow library controller the library home also reads; Runs keep the
 * Sessions list's own sessionWork controls and never take a definition space.
 */
const WorkflowsColumnList = React.memo(function WorkflowsColumnList(props: Readonly<{
    surface: 'plane' | 'page';
    view: WorkflowsColumnView;
    onSelectView: (view: WorkflowsColumnView) => void;
    headerAction: React.ReactNode;
    pathname: string;
}>) {
    const presented = useLayoutPresentationActive();
    const definitions = props.view === 'definitions';
    const eventsShown = props.view === 'events';
    const libraryView = useWorkflowLibraryView(presented && definitions);
    const events = useWorkflowsColumnEvents(presented && eventsShown);
    const router = useRouter();
    // Beside the main pane the Events view opens its page there ("Pick an event"); the other views leave main as it is.
    const selectView = useEventCallback((next: WorkflowsColumnView) => {
        props.onSelectView(next);
        if (next === 'events' && !isWorkflowEventsPath(props.pathname)) router.push(WORKFLOWS_EVENTS_ROUTE as never);
    });
    const header = useWorkflowLibrarySpaceHeader(libraryView, 'workflows-column-space');
    // The sidebar keeps its own search beside "+" and its spaces strip, as the Sessions sidebar does, also beside the
    // index page (owner 2026-11-19 15:10Z, over the lab's navigation-only column). Both places narrow through the one
    // Workflow library draft, so a space or search set in either reads the same in both.
    const spaceControls = definitions;
    const { searchQuery, setSearchQuery } = libraryView;
    const search = React.useMemo(() => spaceControls ? {
        value: searchQuery, onChangeText: setSearchQuery,
        placeholder: t('workflows.destination.searchPlaceholder'), testID: 'workflows-column:search',
    } : null, [searchQuery, setSearchQuery, spaceControls]);
    const { theme } = useUnistyles();
    const viewSwitch = <SegmentedTabBar<WorkflowsColumnView>
        testIDPrefix="workflows-column:view"
        accessibilityLabel={t('workflows.tabsAccessibility.savedRuns')}
        compact
        segmentSizing="content"
        // Labelled, as the lab's column draws it (scene 8 review 12): the three views read by name, not by glyph alone.
        iconPlacement="leading"
        tabs={[
            { id: 'definitions', label: t('workflows.title'), icon: <Icon name="tree-structure" size={15} color={theme.colors.text.secondary} /> },
            { id: 'runs', label: t('workflows.tabs.runs'), icon: <Icon name="play-circle" size={15} color={theme.colors.text.secondary} /> },
            { id: 'events', label: t('workflows.tabs.events'), icon: <Icon name="pulse" size={15} color={theme.colors.text.secondary} /> },
        ]}
        activeTabId={props.view}
        onSelectTab={selectView}
    />;
    return <CollectionList
        testID="workflows-column:list"
        surface={props.surface}
        title={t('workflows.title')}
        {...(spaceControls ? { titleControl: header.titleControl } : {})}
        search={search}
        strip={<>
            <View testID="workflows-column:view-band" style={styles.viewBand}>{viewSwitch}</View>
            {/* The spaces take their own line under the switch (scene 8 column), so neither squeezes the other. */}
            {spaceControls ? <View style={styles.viewBandStrip}>{header.strip}</View> : null}
            {/* The listening line takes its own line under the switch: beside it, its time would be cut (r3 live). */}
            {eventsShown ? <View style={styles.eventsHead}>
                <WorkflowsColumnEventsListening state={events} />
                <WorkflowsColumnEventsFilters state={events} />
            </View> : null}
            {spaceControls ? header.conditionRow : null}
            {spaceControls ? header.overlays : null}
        </>}
        headerAction={<View style={styles.headerActions}>{spaceControls ? header.filterButton : null}{props.headerAction}</View>}
        // Both lists stay built once shown and the switch only presents one: a switch never rebuilds a list.
        scrollContent={<>
            <RetainedPanelSurface isActive={definitions} hiddenMode="activity" testID="workflows-column:definitions">
                <ItemList presentation="grouped" style={styles.definitionsList}>
                    <WorkflowsColumnDefinitions libraryView={libraryView} />
                </ItemList>
            </RetainedPanelSurface>
            <RetainedPanelSurface isActive={props.view === 'runs'} hiddenMode="activity" testID="workflows-column:runs">
                <SessionsList fixedShow="runs" pathname={props.pathname} />
            </RetainedPanelSurface>
            <RetainedPanelSurface isActive={eventsShown} hiddenMode="activity" testID="workflows-column:events">
                <WorkflowsColumnEventsRows feed={events.feed} scope={events.scope} filter={events.filter} surface={props.surface}
                    active={presented && eventsShown} />
            </RetainedPanelSurface>
        </>}
    />;
});

const WorkflowsColumnDefinitions = React.memo(function WorkflowsColumnDefinitions(props: Readonly<{
    libraryView: WorkflowLibraryViewController;
}>) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useGlobalSearchParams<{ trigger?: string; serverId?: string | string[] }>();
    const selectedDefinitionId = readOpenWorkflowDefinition(pathname);
    const homeUnavailable = useActiveHomeUnavailable();
    const { library, isVisible, visibleLibraryRows, accountWorkflows } = props.libraryView;
    // One Library (Q7): saved workflows and the Account's step-holding triggers, in the owner's one
    // order and count. An Account Workflow opens its settings popover where it stands.
    const accountEditor = useAccountWorkflowEditor({ read: accountWorkflows });
    // One opener for every row: the library's rows keep their identity, so an update re-renders only changed rows.
    const openHref = useEventCallback((href: string) => { router.push(href as never); });
    // Shared and plugin workflows are rows of the same projection the page reads, so every row draws the same facts.
    const { rows } = props.libraryView;
    const split = React.useMemo(() => ({
        sharedWithYou: rows.filter((row): row is SharedLibraryRow => row.group === 'sharedWithYou' && isVisible(row.key)),
        fromPlugins: rows.filter((row): row is PluginLibraryRow => row.group === 'fromPlugins' && isVisible(row.key)),
    }), [isVisible, rows]);
    const empty = visibleLibraryRows.length === 0;
    const firstLoad = empty && (library.status === 'loading' || accountWorkflows.status === 'loading');
    const libraryFailed = empty && !firstLoad && library.status === 'failed' && !homeUnavailable;
    // The Account half failed while saved workflows show: said once, under the rows, so they never move.
    const accountFailed = accountWorkflows.status === 'failed' && !libraryFailed && !homeUnavailable;
    return <>
        {homeUnavailable ? <View style={styles.freshness}><HomeReachabilityGate variant="line">{null}</HomeReachabilityGate></View> : null}
        <CollectionListGroupLabel testID="workflows-column:group:library" title={t('workflows.destination.sections.library')}
            {...(visibleLibraryRows.length > 0 ? { count: visibleLibraryRows.length } : {})} first />
        {firstLoad ? <CollectionSkeletonRows count={3} /> : null}
        {libraryFailed ? <View style={collectionListStyles.stateLine}><SurfaceStateCard testID="workflows-column:library:failed" size="line" kind="error"
            title={t('workflows.loadFailedTitle')} reason={t('workflows.loadFailedBody')} action={{ label: t('workflows.retry'), onPress: library.retry, testID: 'workflows-column:library:failed:retry' }}
            accessibilitySemantics="alert" /></View> : null}
        {empty && !firstLoad && !libraryFailed && !accountFailed ? <EmptyState testID="workflows-column:library:empty"
            layout="line" title={t('workflows.destination.libraryEmpty')} /> : null}
        {visibleLibraryRows.map((row, index) => <CollectionRowOrder key={row.key} followed={index < visibleLibraryRows.length - 1}
            precedesSelected={libraryRowSelected(visibleLibraryRows[index + 1], selectedDefinitionId, params.trigger)}>
        <ColumnRowWindow id={row.key} index={index}
            pinned={libraryRowSelected(row, selectedDefinitionId, params.trigger)}>
            {'definition' in row ? (
                <ColumnDefinitionRow row={row}
                    selected={selectedDefinitionId === row.definition.definitionId}
                    href={row.openTarget.href} onOpen={openHref} />
            ) : (
                <ColumnAccountWorkflowEntry row={row} editor={accountEditor} deepLink={params.trigger === row.accountTrigger.automationId} />
            )}
        </ColumnRowWindow></CollectionRowOrder>)}
        <WorkflowLibraryFreshness library={library} hasRows={!empty} />
        {accountFailed ? <View style={styles.stale}>
            <SurfaceFreshnessLine testID="workflows-column:library:account-failed" tone="warning"
                reason={t('workflows.triggers.section.accountLoadFailed')}
                action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: accountWorkflows.retry }} />
        </View> : null}
        {accountEditor.popover}
        {/* A retained link to another Home's trigger keeps that Home's own list and editor. */}
        {readSessionRouteServerId(params) ? <AccountTriggersSection /> : null}
        {split.sharedWithYou.length > 0 ? <>
            <CollectionListGroupLabel testID="workflows-column:group:sharedWithYou" title={t('workflows.destination.sections.sharedWithYou')}
                count={split.sharedWithYou.length} />
            {split.sharedWithYou.map((row, index) => <CollectionRowOrder key={row.key}
                followed={index < split.sharedWithYou.length - 1}
                precedesSelected={split.sharedWithYou[index + 1]?.key === selectedDefinitionId}>
            <ColumnRowWindow id={row.key}
                index={visibleLibraryRows.length + index} pinned={selectedDefinitionId === row.key}>
                <ColumnDefinitionRow row={row} testIDPrefix="workflows-column:shared"
                    selected={selectedDefinitionId === row.key} href={row.openTarget.href} onOpen={openHref} />
            </ColumnRowWindow></CollectionRowOrder>)}
        </> : null}
        <ColumnBuiltins selectedDefinitionId={selectedDefinitionId} isVisible={isVisible} />
        {split.fromPlugins.length > 0 ? <>
            <CollectionListGroupLabel testID="workflows-column:group:fromPlugins" title={t('workflows.plugins.fromPlugins')}
                count={split.fromPlugins.length} />
            {split.fromPlugins.map((row, index) => <CollectionRowOrder key={row.key}
                followed={index < split.fromPlugins.length - 1}
                precedesSelected={split.fromPlugins[index + 1]?.key === selectedDefinitionId}>
            <ColumnRowWindow id={row.key}
                index={visibleLibraryRows.length + split.sharedWithYou.length + index} pinned={selectedDefinitionId === row.key}>
                <WorkflowColumnRow row={row} title={row.plugin.title} fallbackLine={row.plugin.description ?? null}
                    href={`/workflows/${encodeURIComponent(row.key)}`} testID={`workflows-column:plugin:${row.key}`}
                    selected={selectedDefinitionId === row.key}
                    onPress={() => router.push(`/workflows/${encodeURIComponent(row.key)}` as never)} />
            </ColumnRowWindow></CollectionRowOrder>)}
        </> : null}
    </>;
});

/**
 * A column row's near-viewport window: the Library scales with the Account, so only rows near the column's
 * viewport are built. A pinned row (the open one, a deep-linked Account Workflow) stays built where it stands.
 */
function ColumnRowWindow(props: Readonly<{ id: string; index: number; pinned: boolean; children: React.ReactNode }>) {
    const rowHeight = HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight;
    return <NearViewportWindow id={props.id} testID={`workflows-column:row-window:${props.id}`} pinned={props.pinned}
        estimatedTop={props.index * rowHeight} estimatedHeight={rowHeight}>{props.children}</NearViewportWindow>;
}

type SharedLibraryRow = Extract<WorkflowLibraryItem, { group: 'sharedWithYou' }>;
type PluginLibraryRow = Extract<WorkflowLibraryItem, { group: 'fromPlugins' }>;
type DefinitionLibraryRow = Extract<WorkflowLibraryItem, { definition: unknown }>;

/** A saved or shared workflow's sidebar row: its name, what it uses, its state and trigger, its recent runs. */
const ColumnDefinitionRow = React.memo(function ColumnDefinitionRow(props: Readonly<{ row: DefinitionLibraryRow;
    selected: boolean; href: string; onOpen: (href: string) => void; testIDPrefix?: string }>) {
    const { row, href, onOpen } = props;
    const onPress = React.useCallback(() => onOpen(href), [onOpen, href]);
    const { definition } = row;
    return <WorkflowColumnRow row={row} title={formatWorkflowDefinitionLibraryTitle(definition)}
        fallbackLine={definition.contentStatus === 'unavailable'
            ? formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason) : null}
        href={`/workflows/${encodeURIComponent(definition.definitionId)}`}
        testID={`${props.testIDPrefix ?? 'workflows-column:library'}:${definition.definitionId}`}
        selected={props.selected} onPress={onPress} />;
});

/** An Account Workflow's Library entry: its settings anchor around the row, re-rendered only when the row changes. */
const ColumnAccountWorkflowEntry = React.memo(function ColumnAccountWorkflowEntry(props: Readonly<{ row: AccountWorkflowLibraryRow;
    editor: ReturnType<typeof useAccountWorkflowEditor>; deepLink: boolean }>) {
    const { row } = props;
    const renderRow = React.useCallback((open: () => void) => <WorkflowColumnRow row={row} title={row.name}
        testID={`workflows-column:library:${row.key}`} selected={false}
        dimmed={isAccountWorkflowOff(row) && !isAccountWorkflowReviewRequired(row)} onPress={open} />, [row]);
    return <AccountWorkflowRowAnchor row={row} editor={props.editor} deepLink={props.deepLink}>{renderRow}</AccountWorkflowRowAnchor>;
});

/**
 * The column's Built-in group (07 S1, lab `convo-N7`): the same navigation row as Library, mark and name
 * only. Run now and Choose a session… stay on each built-in's page and on the library home, so the
 * column carries one row anatomy and never repeats the home's description.
 */
function ColumnBuiltins(props: Readonly<{ selectedDefinitionId: string | null; isVisible: (key: string) => boolean }>) {
    const router = useRouter();
    // Built-ins narrow with the space and search like every other row (R8-7); none left, no group.
    const entries = getBuiltinWorkflowCatalogV1().filter((entry) => props.isVisible(entry.id));
    if (entries.length === 0) return null;
    return <>
        <CollectionListGroupLabel testID="workflows-column:group:builtin" title={t('workflows.page.blocks.builtin')} count={entries.length} />
        <CollectionRows>
            {entries.map((entry) => {
                const href = createWorkflowDefinitionRoute(entry.id);
                return <CollectionNavigationRow key={entry.id} href={href} testID={`workflows-column:builtin:${entry.id}`}
                    rowRole="item"
                    title={tLoose(entry.titleKey)} icon={<WorkflowBuiltinMark icon={entry.icon} />} selected={props.selectedDefinitionId === entry.id}
                    onPress={() => router.push(href as never)} />;
            })}
        </CollectionRows>
    </>;
}

const styles = StyleSheet.create((theme) => ({
    column: { flex: 1, minHeight: 0 },
    views: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop,
        flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    // As the destination's page (a phone), the switch sits on the page sheets' edge, not the column's row inset.
    viewsOnPage: { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
    /** The page form's head keeps no page-end padding of its own: the views' content follows it. */
    pageHead: { paddingBottom: 0 },
    pageRuns: { flex: 1, paddingBottom: 0 },
    // The strip is already on the column's edge: the line and pills start where the title does.
    eventsHead: { gap: theme.space.s4, paddingTop: theme.space.s4 },
    eventsPageHead: { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx, paddingTop: theme.space.s12, gap: theme.space.s4 },
    // Under the page's large title, the same gap the Inbox's tabs keep (lab `phone-P4`).
    viewsUnderPageTitle: { paddingTop: theme.space.s8, paddingBottom: 0 },
    viewTabs: { flex: 1, minWidth: 0 },
    definitionsList: { backgroundColor: 'transparent' },
    // The switch's one place in both views: the band under the title, ending the row the spaces strip
    // leads (Definitions) or alone at the row's end (Runs). The title row's width never decides where it sits.
    viewBand: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    // The band packs from the title's leading text edge, like every column's (SHELL-ACCEPT-1117): the switch follows the strip.
    viewBandStrip: { paddingTop: theme.space.s4, minWidth: 0 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    freshness: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop },
    // The column's row inset, so the line's edges sit on the rows' edges.
    stale: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingTop: theme.space.s4 },
    // A column section's state is the one in-list state line, on the rows' content edge.
}));

/** The Events view as the destination's page: the listening line and chips on the page's edge, then the rows. */
const WorkflowsColumnEventsPage = React.memo(function WorkflowsColumnEventsPage(props: Readonly<{ active: boolean }>) {
    const presented = useLayoutPresentationActive();
    const events = useWorkflowsColumnEvents(presented && props.active);
    return <PageFrame column="wide" content="column" style={styles.pageRuns}>
        <View style={styles.eventsPageHead}>
            <WorkflowsColumnEventsListening state={events} />
            <WorkflowsColumnEventsFilters state={events} />
        </View>
        <ItemList presentation="grouped" style={styles.definitionsList}>
            <WorkflowsColumnEventsRows feed={events.feed} scope={events.scope} filter={events.filter} surface="page" active={presented && props.active} />
        </ItemList>
    </PageFrame>;
});

/** Whether a Library row is the open one: its definition's page, or the account workflow a deep link opened. */
function libraryRowSelected(
    row: Readonly<{ definition: Readonly<{ definitionId: string }> }> | Readonly<{ accountTrigger: Readonly<{ automationId: string }> }> | undefined,
    selectedDefinitionId: string | null,
    trigger: unknown,
): boolean {
    if (row === undefined) return false;
    return 'definition' in row ? selectedDefinitionId === row.definition.definitionId : trigger === row.accountTrigger.automationId;
}
