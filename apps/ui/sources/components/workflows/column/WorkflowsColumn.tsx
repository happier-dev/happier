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
import { CollectionList, CollectionListGroupLabel, CollectionNavigationRow, CollectionSkeletonRows, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { NavigationLargeTitleProvider, useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PhoneMainTabLine } from '@/components/navigation/shell/PhoneMainTabLine';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { HomeReachabilityGate, useActiveHomeUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { AccountTriggersSection, useAccountWorkflowEditor } from '@/components/workflows/triggers/AccountTriggersSection';
import { AccountWorkflowRowAnchor, formatAccountWorkflowLine, isAccountWorkflowOff, isAccountWorkflowReviewRequired,
    type AccountWorkflowLibraryRow } from '@/components/workflows/library/AccountWorkflowRowAnchor';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import type { WorkflowLibraryDefinition } from '@/components/workflows/library/workflowLibraryReads';
import type { WorkflowAutomationRunSummary, WorkflowLibraryRunSummary } from '@/components/workflows/library/useWorkflowLibrarySummaries';
import { useWorkflowLibraryView, type WorkflowLibraryViewController } from '@/components/workflows/library/useWorkflowLibraryView';
import { useWorkflowLibrarySpaceHeader } from '@/components/workflows/library/useWorkflowLibrarySpaceHeader';
import { hasWorkingWorkflowLibraryRun } from '@/components/workflows/library/workflowRunStrip';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { formatTriggerSetSummary } from '@/components/workflows/triggers/formatTriggerSummary';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '@/components/workflows/presentation/workflowProblemPresentation';

import { WorkflowsColumnActions } from './WorkflowsColumnActions';
import { WorkflowsColumnHeadsPageContext, WorkflowsColumnOwnsCreationContext } from './workflowsColumnCreation';
import { WorkflowPurposeGlyph } from '../presentation/WorkflowPurposeGlyph';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { collectionSpaceSettingRefs } from '@/components/settings/session/collectionSpaceSettings';

type WorkflowsColumnView = 'definitions' | 'runs';

function isRunPath(pathname: string): boolean {
    return /^\/workflows\/runs(?:\/|$)/.test(pathname);
}

function readOpenDefinition(pathname: string): string | null {
    const match = /^\/workflows\/([^/?#]+)$/.exec(pathname);
    if (!match || ['new', 'runs', 'settings', 'edit'].includes(match[1]!)) return null;
    try { return decodeURIComponent(match[1]!); } catch { return match[1]!; }
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
    // A phone-sized window with no navigation bar over the page: it opens on its name, with the actions on the
    // name's line, then the switch. Under a native header the bar already carries the name.
    const headsPage = phone && !titleChrome && props.definitionsContent !== undefined;
    const pathname = usePathname();
    const params = useGlobalSearchParams<{ trigger?: string }>();
    const [view, setView] = React.useState<WorkflowsColumnView>(() => isRunPath(pathname) ? 'runs' : 'definitions');
    const filtersRequested = useSettingRevealRequested([collectionSpaceSettingRefs('workflow').filters]);
    React.useEffect(() => {
        if (filtersRequested) setView('definitions');
    }, [filtersRequested]);
    React.useEffect(() => {
        if (params.trigger) setView('definitions');
        else if (isRunPath(pathname)) setView('runs');
        else if (readOpenDefinition(pathname)) setView('definitions');
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
                    { id: 'definitions', label: t('workflows.list.definitions') },
                    { id: 'runs', label: t('workflows.tabs.runs') },
                ]}
                activeTabId={view}
                onSelectTab={setView}
                segmentSizing="equal"
                />
            </View>
            {props.definitionsContent === undefined || headsPage ? null : <WorkflowsColumnActions canCreate={ownsCreation} />}
        </View>;
    // Without a shell column, Definitions is the full home, not a second compact navigation list.
    // The same view owner still reaches Runs; the home carries its own page identity, actions and spaces.
    if (props.definitionsContent !== undefined && access.kind === 'workflows') {
        return <View testID="workflows-column" style={styles.column}>
            {headsPage ? <View testID="workflows-column:header" style={{ paddingTop: safeAreaTop }}>
                <PhoneMainTabLine />
                <NavigationLargeTitleProvider largeTitle>
                    <PageHeader title={t('workflows.title')} actionsPlacement="page" actions={<WorkflowsColumnActions canCreate={ownsCreation} />} />
                </NavigationLargeTitleProvider>
            </View> : null}
            {viewTabs}
            {view === 'runs' ? <SessionsList fixedShow="runs" pathname={pathname} /> : (
                <WorkflowsColumnOwnsCreationContext.Provider value={ownsCreation}>
                    <WorkflowsColumnHeadsPageContext.Provider value={headsPage}>{props.definitionsContent}</WorkflowsColumnHeadsPageContext.Provider>
                </WorkflowsColumnOwnsCreationContext.Provider>
            )}
        </View>;
    }
    const headerAction = access.kind === 'workflows' || access.kind === 'triggersOnly'
        ? <WorkflowsColumnActions canCreate={access.kind === 'workflows'} /> : null;
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
        >
            {access.kind === 'triggersOnly' ? <AccountTriggersSection first /> : null}
        </CollectionList>
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
    const libraryView = useWorkflowLibraryView(presented && definitions);
    const header = useWorkflowLibrarySpaceHeader(libraryView, 'workflows-column-space');
    const { theme } = useUnistyles();
    const viewSwitch = <SegmentedTabBar<WorkflowsColumnView>
        testIDPrefix="workflows-column:view"
        accessibilityLabel={t('workflows.tabsAccessibility.savedRuns')}
        compact
        segmentSizing="content"
        tabs={[
            { id: 'definitions', label: t('workflows.list.definitions'), icon: <Icon name="tree-structure" size={15} color={theme.colors.text.secondary} /> },
            { id: 'runs', label: t('workflows.tabs.runs'), icon: <Icon name="play-circle" size={15} color={theme.colors.text.secondary} /> },
        ]}
        activeTabId={props.view}
        onSelectTab={props.onSelectView}
    />;
    return <CollectionList
        testID="workflows-column:list"
        surface={props.surface}
        title={t('workflows.title')}
        {...(definitions ? { titleControl: header.titleControl } : {})}
        strip={<>
            <View testID="workflows-column:view-band" style={styles.viewBand}>
                <View style={styles.viewBandLead}>{definitions ? header.strip : null}</View>
                {viewSwitch}
            </View>
            {header.overlays}
        </>}
        headerAction={<View style={styles.headerActions}>{definitions ? header.filterButton : null}{props.headerAction}</View>}
        scrollContent={definitions ? <ItemList presentation="grouped" style={styles.definitionsList}>
            <WorkflowsColumnDefinitions libraryView={libraryView} />
        </ItemList> : <SessionsList fixedShow="runs" pathname={props.pathname} />}
    />;
});

const WorkflowsColumnDefinitions = React.memo(function WorkflowsColumnDefinitions(props: Readonly<{
    libraryView: WorkflowLibraryViewController;
}>) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useGlobalSearchParams<{ trigger?: string; serverId?: string | string[] }>();
    const selectedDefinitionId = readOpenDefinition(pathname);
    const homeUnavailable = useActiveHomeUnavailable();
    const { library, isVisible, visibleLibraryRows, accountWorkflows } = props.libraryView;
    // One Library (Q7): saved workflows and the Account's step-holding triggers, in the owner's one
    // order and count. An Account Workflow opens its settings popover where it stands.
    const accountEditor = useAccountWorkflowEditor({ read: accountWorkflows });
    const split = React.useMemo(() => ({
        sharedWithYou: props.libraryView.split.sharedWithYou.filter((definition) => isVisible(definition.definitionId)),
        fromPlugins: props.libraryView.split.fromPlugins.filter((plugin) => isVisible(plugin.workflow)),
    }), [isVisible, props.libraryView.split]);
    const empty = visibleLibraryRows.length === 0;
    const firstLoad = empty && (library.status === 'loading' || accountWorkflows.status === 'loading');
    const libraryFailed = empty && !firstLoad && library.status === 'failed' && !homeUnavailable;
    // The Account half failed while saved workflows show: said once, under the rows, so they never move.
    const accountFailed = accountWorkflows.status === 'failed' && !libraryFailed && !homeUnavailable;
    return <>
        {homeUnavailable ? <View style={styles.freshness}><HomeReachabilityGate variant="line">{null}</HomeReachabilityGate></View> : null}
        <CollectionListGroupLabel testID="workflows-column:group:library" title={t('workflows.destination.sections.library')} countPlacement="title"
            {...(visibleLibraryRows.length > 0 ? { count: visibleLibraryRows.length } : {})} first />
        {firstLoad ? <CollectionSkeletonRows count={3} /> : null}
        {libraryFailed ? <View style={collectionListStyles.stateLine}><SurfaceStateCard testID="workflows-column:library:failed" size="line" kind="error"
            title={t('workflows.loadFailedTitle')} reason={t('workflows.loadFailedBody')} action={{ label: t('workflows.retry'), onPress: library.retry, testID: 'workflows-column:library:failed:retry' }}
            accessibilitySemantics="alert" /></View> : null}
        {empty && !firstLoad && !libraryFailed && !accountFailed ? <EmptyState testID="workflows-column:library:empty"
            layout="line" title={t('workflows.destination.libraryEmpty')} /> : null}
        {visibleLibraryRows.map((row) => 'definition' in row ? (
            <ColumnDefinitionRow key={row.key} definition={row.definition} summary={row.lastRunSummary}
                selected={selectedDefinitionId === row.definition.definitionId}
                onPress={() => router.push(row.openTarget.href as never)} />
        ) : (
            <AccountWorkflowRowAnchor key={row.key} row={row} editor={accountEditor} deepLink={params.trigger === row.accountTrigger.automationId}>
                {(open) => <ColumnAccountWorkflowRow row={row} onPress={open} />}
            </AccountWorkflowRowAnchor>
        ))}
        {accountFailed ? <View style={styles.stale}>
            <SurfaceFreshnessLine testID="workflows-column:library:account-failed" tone="warning"
                reason={t('workflows.triggers.section.accountLoadFailed')}
                action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: accountWorkflows.retry }} />
        </View> : null}
        {accountEditor.popover}
        {/* A retained link to another Home's trigger keeps that Home's own list and editor. */}
        {readSessionRouteServerId(params) ? <AccountTriggersSection /> : null}
        {split.sharedWithYou.length > 0 ? <>
            <CollectionListGroupLabel testID="workflows-column:group:sharedWithYou" title={t('workflows.destination.sections.sharedWithYou')} countPlacement="title"
                count={split.sharedWithYou.length} />
            {split.sharedWithYou.map((definition) => <CollectionNavigationRow key={definition.definitionId}
                href={`/workflows/${encodeURIComponent(definition.definitionId)}`} testID={`workflows-column:shared:${definition.definitionId}`}
                title={formatWorkflowDefinitionLibraryTitle(definition)} icon={<Icon name="tree-structure" />} selected={selectedDefinitionId === definition.definitionId}
                {...(definition.contentStatus === 'unavailable' ? { subtitle: formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason) } : {})}
                onPress={() => router.push(`/workflows/${encodeURIComponent(definition.definitionId)}` as never)} />)}
        </> : null}
        <ColumnBuiltins selectedDefinitionId={selectedDefinitionId} isVisible={isVisible} />
        {split.fromPlugins.length > 0 ? <>
            <CollectionListGroupLabel testID="workflows-column:group:fromPlugins" title={t('workflows.plugins.fromPlugins')} countPlacement="title"
                count={split.fromPlugins.length} />
            {split.fromPlugins.map((workflow) => <CollectionNavigationRow key={workflow.workflow}
                href={`/workflows/${encodeURIComponent(workflow.workflow)}`} testID={`workflows-column:plugin:${workflow.workflow}`}
                title={workflow.title} icon={<Icon name="tree-structure" />} selected={selectedDefinitionId === workflow.workflow}
                onPress={() => router.push(`/workflows/${encodeURIComponent(workflow.workflow)}` as never)} />)}
        </> : null}
    </>;
});

/**
 * What a Library row says at its end (lab `nav-N1` column): the one amber mark while a run waits for you,
 * "Running" while one works, else how long ago it last ran. Runs themselves live in the Runs view (R-22).
 */
function readDefinitionLife(summary: WorkflowLibraryRunSummary | undefined):
    Readonly<{ kind: 'needsYou' | 'running' | 'quiet' }> | Readonly<{ kind: 'rested'; age: string }> {
    if (summary === undefined) return { kind: 'quiet' };
    if (summary.needsYouRunId !== null) return { kind: 'needsYou' };
    if (hasWorkingWorkflowLibraryRun(summary)) return { kind: 'running' };
    const startedAt = summary.lastRun === null ? Number.NaN : Date.parse(summary.lastRun.startedAt);
    return Number.isFinite(startedAt) ? { kind: 'rested', age: formatRelativeTimeShort(startedAt, Date.now()) } : { kind: 'quiet' };
}

/** A saved workflow's Library row: its name, what makes it run by itself, and how its runs stand. */
function ColumnDefinitionRow(props: Readonly<{ definition: WorkflowLibraryDefinition; summary: WorkflowLibraryRunSummary | undefined;
    selected: boolean; onPress: () => void }>) {
    const { definition } = props;
    const life = readDefinitionLife(props.summary);
    const title = formatWorkflowDefinitionLibraryTitle(definition);
    const subtitle = definitionSubtitle(definition);
    return <CollectionNavigationRow
        href={`/workflows/${encodeURIComponent(definition.definitionId)}`} testID={`workflows-column:library:${definition.definitionId}`}
        title={title} icon={<Icon name="tree-structure" />} selected={props.selected}
        {...(subtitle === null ? {} : { subtitle })}
        {...lifeProps(life, title, `workflow-definition-${definition.definitionId}`)}
        onPress={props.onPress} />;
}

/**
 * An Account Workflow's Library row (Q7): the same row as a saved workflow's, its trigger as the quiet
 * line. Turned off it rests dimmed; its settings (and Turn on) are one press away.
 */
function ColumnAccountWorkflowRow(props: Readonly<{ row: AccountWorkflowLibraryRow; onPress: () => void }>) {
    const { row } = props;
    const reviewRequired = isAccountWorkflowReviewRequired(row);
    const life: ReturnType<typeof readDefinitionLife> = reviewRequired ? { kind: 'needsYou' } : readAccountWorkflowLife(row.lastRunSummary);
    const line = formatAccountWorkflowLine(row);
    return <CollectionNavigationRow testID={`workflows-column:library:${row.key}`}
        title={row.name} icon={<Icon name="tree-structure" />} selected={false}
        {...(line === null ? {} : { subtitle: line })}
        dimmed={isAccountWorkflowOff(row) && !reviewRequired}
        {...lifeProps(life, row.name, `workflow-account-${row.accountTrigger.automationId}`, reviewRequired ? line ?? undefined : undefined)}
        onPress={props.onPress} />;
}

function lifeProps(life: ReturnType<typeof readDefinitionLife>, title: string, testIDSuffix: string, word?: string) {
    if (life.kind === 'rested') return { detail: life.age };
    if (life.kind === 'quiet') return {};
    const state = word ?? t(life.kind === 'needsYou' ? 'workflows.destination.sections.needsYou' : 'workflows.destination.sections.running');
    return {
        status: <WorkStatusRowMark testIDSuffix={testIDSuffix}
            status={resolveWorkStatusTone({ kind: 'workflow', facts: {
                word: state, needsYouCount: life.kind === 'needsYou' ? 1 : 0, hasActiveRun: life.kind === 'running' } })} />,
        accessibilityLabel: `${title}, ${state}`,
    };
}

/** The same three answers from an Account Workflow's one last run. */
function readAccountWorkflowLife(summary: WorkflowAutomationRunSummary | undefined): ReturnType<typeof readDefinitionLife> {
    const lastRun = summary?.lastRun ?? null;
    if (lastRun === null) return { kind: 'quiet' };
    if (lastRun.attentionRequired || lastRun.invocationAttentionRequired) return { kind: 'needsYou' };
    if (hasWorkingWorkflowLibraryRun({ recent: [{ ...lastRun, runId: lastRun.id }] })) return { kind: 'running' };
    const startedAt = Date.parse(lastRun.startedAt);
    return Number.isFinite(startedAt) ? { kind: 'rested', age: formatRelativeTimeShort(startedAt, Date.now()) } : { kind: 'quiet' };
}

/**
 * A library row's second line (lab `convo-N7`): what makes it run by itself ("Every night at 02:00 · 1 more"),
 * or why it cannot be read. A manual workflow is its name alone, so the index stays quiet.
 */
function definitionSubtitle(definition: WorkflowLibraryDefinition): string | null {
    if (definition.contentStatus === 'unavailable') return formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason);
    return definition.triggers.length > 0 ? formatTriggerSetSummary(definition.triggers) : null;
}

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
        <CollectionListGroupLabel testID="workflows-column:group:builtin" title={t('workflows.page.blocks.builtin')} countPlacement="title" count={entries.length} />
        {entries.map((entry) => {
            const href = createWorkflowDefinitionRoute(entry.id);
            return <CollectionNavigationRow key={entry.id} href={href} testID={`workflows-column:builtin:${entry.id}`}
                title={tLoose(entry.titleKey)} icon={<WorkflowPurposeGlyph purpose={entry.purpose} />} selected={props.selectedDefinitionId === entry.id}
                onPress={() => router.push(href as never)} />;
        })}
    </>;
}

const styles = StyleSheet.create((theme) => ({
    column: { flex: 1, minHeight: 0 },
    views: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop,
        flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    // As the destination's page (a phone), the switch sits on the page sheets' edge, not the column's row inset.
    viewsOnPage: { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
    // Under the page's large title, the same gap the Inbox's tabs keep (lab `phone-P4`).
    viewsUnderPageTitle: { paddingTop: theme.space.s8, paddingBottom: 0 },
    viewTabs: { flex: 1, minWidth: 0 },
    definitionsList: { backgroundColor: 'transparent' },
    // The switch's one place in both views: the band under the title, ending the row the spaces strip
    // leads (Definitions) or alone at the row's end (Runs). The title row's width never decides where it sits.
    viewBand: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    viewBandLead: { flex: 1, minWidth: 0 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    freshness: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop },
    // The column's row inset, so the line's edges sit on the rows' edges.
    stale: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingTop: theme.space.s4 },
    // A column section's state is the one in-list state line, on the rows' content edge.
}));
