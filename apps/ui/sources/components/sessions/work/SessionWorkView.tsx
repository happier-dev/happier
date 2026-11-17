import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { usePageColumn } from '@/components/ui/lists/listPresentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { Item } from '@/components/ui/lists/Item';
import { SessionAgentsLaunchMenu } from '@/components/sessions/agents/launch/SessionAgentsLaunchMenu';
import { useSessionGoalControlEntry } from '@/components/sessions/workState/openSessionGoalControl';
import { SessionGoalValueRow } from '@/components/sessions/workState/SessionGoalControlContent';
import { SessionAgentStartDraftRows } from '@/components/sessions/agents/launch/SessionAgentStartDraftRows';
import { useReadRetainedComparisonReviewDraft, useSessionRetainedLauncherDraftKeys } from '@/components/sessions/agents/launch/useSessionRetainedLauncherDraftKeys';
import { createComparisonReviewExecutionRunDraftDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { projectAgentStartDrafts, type AgentStartDraft } from '@/components/sessions/agents/launch/agentStartDrafts';
import { useSessionAgentLauncher, type SessionAgentLauncher } from '@/components/sessions/agents/launch/useSessionAgentLauncher';
import { groupSessionSubagents } from '@/components/sessions/agents/list/groupSessionSubagents';
import { SessionSubagentGroup } from '@/components/sessions/agents/list/SessionSubagentGroup';
import {
    readSessionAgentActivityRows,
    type SessionAgentActivityRow,
} from '@/components/sessions/agents/presentation/sessionAgentActivityRows';
import { useSessionAgentActivityPreviews } from '@/components/sessions/agents/presentation/useSessionAgentActivityPreviews';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import {
    createSessionTeammateLauncherDetailsTab,
    hasSessionTeammateLauncher,
} from '@/agents/registry/sessionSubagentUiBehavior';
import { useSessionAgentRowOriginLabels } from '@/components/sessions/agents/presentation/useSessionAgentRowOriginLabels';
import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { retryMachineReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSessionTranscriptLoaded } from '@/sync/store/hooks';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { HappierWorkDisclosureLine, HAPPIER_WORK_PANE_METRICS, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { describeWorkStatusBucket } from '@/components/work/status/workStatusBuckets';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { CurrentSessionPresentationIntentResultV1 } from '@happier-dev/protocol/sessions';

import { useSessionWorkSources } from './sessionWorkSources';
import { useSessionWorkMap } from './useSessionWorkMap';
import { showPutUnderSessionModal } from './PutUnderSessionModal';
import { SessionWorkMapView } from './SessionWorkMapView';
import { useSessionWorkMenuActions } from './sessionWorkMenuActions';
import { useSessionLineage } from './sessionLineage';
import { createSessionWorkMapDetailsTab, isSessionWorkMapDetailsResource } from './SessionWorkMapDetailsView';
import { WorkItemRow, WorkViewportContext, useWorkScrollViewport } from './WorkItemRow';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { SessionWorkPresentationContext, type SessionWorkPresentationBinding } from './sessionWorkPresentation';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { useSessionArchivedReports } from './useSessionArchivedReports';
import { WorkRowUnarchive } from './WorkRowUnarchive';
import { readSessionWorkflowStepRunId, SessionStepWork } from './SessionStepWork';
import { describeWorkPaneLine } from './workPaneLine';
import { SessionWorkPlanRow } from './SessionWorkPlanRow';
import { SessionWorkDigest } from './SessionWorkDigest';
import { deriveSessionCoordinatorV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorV1';
import { WorkFlatSheet, WorkSection } from './WorkSection';
import { SessionHabitsSection } from './SessionSetupSections';
import { useSessionWorkTriggersReveal } from './sessionWorkTriggersReveal';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { SessionTriggersSectionActions } from '@/components/workflows/triggers/SessionTriggersSection';
import {
    groupWorkByState, resolveWorkMachineNotices, resolveWorkReadPresentation, resolveWorkTitleTailStarts,
    type WorkItem, type WorkStateGroups,
} from './workProjection';

/**
 * The Session's Work tab (ORC §3.8; lab `session-A`, `session-G`, `session-S`).
 *
 * One pane for everything this Session leads: the Sessions under it (the `manager` tree), the
 * workflows and background runs it started, and the agents working inside it — read from the ONE Work
 * projection its Session host mounted, so the pane, the header strip and "never Finished" agree.
 *
 * Work answers one question, what's happening (coordination lab P1w, owner decision Y5): Managed by
 * and the Goal row, then the list by state (or its Map). How the agent is set up — Role, Instructions,
 * Memory, Context, Voice, Triggers, Roles and Notes — is the Session's Info page
 * (`SessionSetupSections`); who hears about it is People. Rows state where each item stands and open
 * its peek; they carry no answer controls (S-1). The Goal row opens FIN 04's one Goal control, the
 * composer's.
 */

const stylesheet = StyleSheet.create(() => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    scroll: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    // A flat page section (Triggers, as Session Info lays it) keeps the pane's own text edge: it spans the
    // pane, not the work list's inset column.
    paneEdgeSection: {
        marginHorizontal: -HAPPIER_WORK_PANE_METRICS.contentInsetPx,
    },
    content: {
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.contentInsetPx,
        paddingTop: 8,
        paddingBottom: 16,
        gap: 18,
    },
    // The empty pane is its whole content: centred in what is left of it.
    contentEmpty: {
        flexGrow: 1,
    },
    empty: {
        flexGrow: 1,
        justifyContent: 'center',
    },
    marks: {
        flexDirection: 'row',
        gap: 8,
    },
    // The pane header's own action rhythm (PaneHeader `actions`): List | Map · ⤢ · + sit as tightly as
    // its icon buttons so the live line ("2 sessions") keeps its room at the sidebar's narrowest width;
    // the line truncates before any control is dropped (lab `convo-W7`).
    phoneTabs: {
        alignSelf: 'stretch',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
}));

const UNAVAILABLE_REASON_KEYS = {
    notEnabled: 'sessionAgentActivity.roster.unavailable.notEnabled',
    sessionInactive: 'sessionAgentActivity.roster.unavailable.sessionInactive',
    externalRunnerInactive: 'sessionAgentActivity.roster.unavailable.externalRunnerInactive',
} as const;

/** Why agents cannot start here, said rather than hidden (the "+" is not drawn then). */
function resolveUnavailableText(launcher: SessionAgentLauncher, machineName: string | null): string | null {
    const reason = launcher.unavailableReason;
    if (reason === null) return null;
    if (reason === 'machineOffline') {
        return machineName
            ? t('sessionAgentActivity.roster.unavailable.machineOffline', { machine: machineName })
            : t('sessionAgentActivity.roster.unavailable.machineOfflineUnnamed');
    }
    return t(UNAVAILABLE_REASON_KEYS[reason]);
}

export const SessionWorkView = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
    /** The Session pane's exact Home; never infer it from a same-id live cache entry. */
    serverId?: string | null;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    // Hidden Session, wide pane: the rows keep the reading column their Triggers section already takes
    // (an inspector section's page column), so one page never sets two widths.
    const columnMaxWidth = useLayoutMaxWidth(usePageColumn());
    const session = useSessionViewShellSession(props.sessionId, props.serverId);
    const sessionServerId = props.serverId ?? session?.serverId ?? null;
    const router = useRouter();
    const sources = useSessionWorkSources();
    const presentationRef = React.useContext(SessionWorkPresentationContext);
    const presented = useLayoutPresentationActive();
    const projection = sources?.projection ?? null;
    const agentActivity = sources?.agentActivity ?? null;
    const subagents = agentActivity?.subagents ?? EMPTY_SUBAGENTS;

    const launcher = useSessionAgentLauncher({
        sessionId: props.sessionId,
        serverId: sessionServerId,
        scopeId: props.scopeId,
        session,
        subagents,
    });
    // FIN 04's Goal control is the composer's; "+" › Keep going until done… opens it there.
    const goalControlEntry = useSessionGoalControlEntry({ sessionId: props.sessionId, serverId: sessionServerId });
    const machineName = useSessionMachineName(props.sessionId, sessionServerId);
    const { machineReachability, machineLastSeenAt } = useSessionMachineReachability(props.sessionId, sessionServerId);
    const originLabelById = useSessionAgentRowOriginLabels({
        sessionId: props.sessionId,
        serverId: sessionServerId,
        subagents,
    });
    const sessionAgentId = React.useMemo(
        () => (session ? readSessionPresentationAgentId(session) : null),
        [session],
    );

    // Background runs and in-session agents keep their roster rows (their controls — stop, open
    // full, advanced — live on the row's menu). The projection decided which entries they are.
    const entryById = React.useMemo(() => {
        const map = new Map<string, NonNullable<typeof agentActivity>['entries'][number]>();
        for (const entry of agentActivity?.entries ?? []) map.set(entry.id, entry);
        return map;
    }, [agentActivity?.entries]);
    // Every agent-activity item of the projection as its roster row, in projection order.
    const agentRows = React.useMemo(() => {
        if (!agentActivity || !projection) return EMPTY_ROWS;
        const entries = [...projection.backgroundRuns, ...projection.agents].flatMap((item) => {
            if (item.open.kind !== 'agent_activity') return [];
            const entry = entryById.get(item.open.entryId);
            return entry ? [entry] : [];
        });
        return readSessionAgentActivityRows(entries, agentActivity.readSubagentForEntry);
    }, [agentActivity, entryById, projection]);
    const agentRowByEntryId = React.useMemo(() => {
        const map = new Map<string, SessionAgentActivityRow>();
        for (const row of agentRows) map.set(row.entry.id, row);
        return map;
    }, [agentRows]);
    // What each agent row is doing now ("reading RetryBanner.tsx"), hydrated in draw order.
    const activityPreviewById = useSessionAgentActivityPreviews({
        sessionId: props.sessionId,
        serverId: sessionServerId,
        session,
        rows: agentRows,
    });
    // A Claude team group offers "Launch teammate" through the Agent's own launcher (native only).
    const openLauncherDetails = launcher.openDetails;
    const launchTeammate = React.useCallback((teamId: string) => {
        const tab = createSessionTeammateLauncherDetailsTab({ session, teamId });
        if (tab) openLauncherDetails(tab);
    }, [openLauncherDetails, session]);
    const onLaunchTeammate = hasSessionTeammateLauncher(session) ? launchTeammate : null;

    // List | Map is a view of the same work, remembered only while the pane lives.
    const [preferredView, setView] = React.useState<'list' | 'map'>('list');
    const pane = useAppPaneScope(props.scopeId);
    const details = pane.scopeState?.details;
    const detailsGroups = details?.groups ?? (details ? [{ id: null, tabs: details.tabs, activeTabKey: details.activeTabKey }] : []);
    const expandedMapTab = details?.isOpen ? detailsGroups
        .filter(group => !details.maximizedGroupId || group.id === details.maximizedGroupId)
        .flatMap(group => group.tabs.filter(tab => tab.key === group.activeTabKey))
        .find(tab => isSessionWorkMapDetailsResource(tab.resource) && tab.resource.sessionId === props.sessionId) : undefined;
    // Details borrows Map; closing or unmounting that tab reveals the untouched local preference.
    const view = expandedMapTab ? 'list' : preferredView;
    const [recentExpanded, setRecentExpanded] = React.useState(false);
    const { map: workMap, openItem, showItemInTranscript, openSubagentPreview, openSubagentFull, openSubagentAdvanced } = useSessionWorkMap({
        sessionId: props.sessionId,
        serverId: sessionServerId,
        scopeId: props.scopeId,
        subagents,
        session,
        projection,
        active: view === 'map',
    });

    const canExpandMap = deviceType !== 'phone';
    // "Add a trigger…" (the "+" menu) opens the Triggers section's popover right here, anchored at that
    // menu (07 S16, W9): the person stays in the Work pane, and the new trigger appears in the section below.
    const scrollRef = React.useRef<ScrollView>(null);
    // The header's "Open session workflows" opens this tab and asks once for its Triggers (owner 0936 #16): the
    // section's offset in the scroll content, then one scroll to it when both are known.
    const triggersReveal = useSessionWorkTriggersReveal(sessionServerId ? { serverId: sessionServerId, sessionId: props.sessionId } : null);
    const [triggersOffsetY, setTriggersOffsetY] = React.useState<number | null>(null);
    const onTriggersLayout = React.useCallback((event: LayoutChangeEvent) => {
        const y = Math.round(event.nativeEvent.layout.y);
        setTriggersOffsetY((current) => (current === y ? current : y));
    }, []);
    const revealReducedMotion = useReducedMotionPreference();
    React.useEffect(() => {
        if (!triggersReveal.requested || triggersOffsetY === null) return;
        scrollRef.current?.scrollTo({ y: triggersOffsetY, animated: !revealReducedMotion });
        triggersReveal.consume();
    }, [triggersReveal.requested, triggersReveal.consume, triggersOffsetY, revealReducedMotion]);
    const triggersActionsRef = React.useRef<SessionTriggersSectionActions>(null);
    const addMenuAnchorRef = React.useRef<View>(null);
    const openTriggers = React.useCallback(() => {
        triggersActionsRef.current?.openNewTrigger(addMenuAnchorRef);
    }, []);
    // Rows that carry live content (a working run's mini-map) mount it only while on screen here.
    const workViewport = useWorkScrollViewport(scrollRef);
    // Unsent starts lead the list until their first Send (the Start row): the tabs open beside the
    // Session, and the text kept on the Session's draft when no tab shows it (a phone, a closed tab).
    const retainedDraftKeys = useSessionRetainedLauncherDraftKeys({ sessionId: props.sessionId, serverId: sessionServerId });
    const readComparisonReview = useReadRetainedComparisonReviewDraft({ sessionId: props.sessionId, serverId: sessionServerId });
    const startDrafts = React.useMemo(
        () => projectAgentStartDrafts(pane.scopeState?.details, retainedDraftKeys),
        [pane.scopeState?.details, retainedDraftKeys],
    );
    const openLauncherStartDraft = launcher.openStartDraft;
    const openLauncherConversation = launcher.openConversation;
    const openLauncherRun = launcher.openRun;
    const openStartDraft = React.useCallback((draft: AgentStartDraft) => {
        if (draft.tabKey === null) {
            if (draft.comparison) {
                const comparisonReview = readComparisonReview(draft.key);
                if (comparisonReview) openLauncherStartDraft(createComparisonReviewExecutionRunDraftDetailsTab(comparisonReview));
                return;
            }
            // Nothing shows it: start the same ask again, whose launcher reads the retained text back.
            if (draft.intent === null) openLauncherConversation();
            else openLauncherRun(draft.intent, draft.roleId
                ? { roleId: draft.roleId, title: t(`agentStart.startRow.${draft.intent}` as const) }
                : undefined);
            return;
        }
        const details = pane.scopeState?.details;
        const tabs = details?.groups?.flatMap(group => group.tabs) ?? details?.tabs;
        const tab = tabs?.find(candidate => candidate.key === draft.tabKey);
        if (tab) openLauncherStartDraft(tab);
    }, [openLauncherConversation, openLauncherRun, openLauncherStartDraft, pane.scopeState?.details, readComparisonReview]);
    const hasReports = (projection?.summary.sessions ?? 0) > 0;
    // A workflow step's checks are the workflow's (lab `session-F`): no List | Map, ⤢ or "+".
    const stepRunId = readSessionWorkflowStepRunId(session);
    // What this Session led and archived is read here, where it is shown; a closed strip never asks.
    const archivedReports = useSessionArchivedReports({ sessionId: props.sessionId, serverId: sessionServerId, enabled: stepRunId === null });
    const archivedCount = projection?.archivedSessions.length ?? 0;
    // A Session shown here names itself from its own content, like in the sidebar: the pane demands it, so an
    // archived row reads its real title, Agent mark and facts instead of waiting for another surface.
    const shownSessionAddresses = React.useMemo(() => {
        if (!sessionServerId || !projection) return NO_SESSION_ADDRESSES;
        return [...projection.sessions, ...projection.archivedSessions].flatMap((item) => (
            item.open.kind === 'session' ? [{ serverId: sessionServerId, sessionId: item.open.sessionId }] : []
        ));
    }, [projection, sessionServerId]);
    useSessionContentDemand(shownSessionAddresses, { tag: 'sessionWork.hydrateShownSessions', hydrate: 'unsettled', active: stepRunId === null });
    const summary = projection?.summary ?? null;
    // The digest is a coordinator's (C1 R12): the same derived fact as the list's row mark, never a role or stored flag.
    const isCoordinator = deriveSessionCoordinatorV1({
        managedSessions: session?.managedSessions, receivedRuleCount: session?.receivedRuleCount,
    }) === true;
    const sessionItemById = React.useMemo(() => {
        const items = new Map<string, WorkItem>();
        for (const item of [...(projection?.sessions ?? []), ...(projection?.archivedSessions ?? [])]) {
            if (item.open.kind === 'session') items.set(item.open.sessionId, item);
        }
        return items;
    }, [projection]);
    const liveLine = React.useMemo(() => (summary ? describeWorkPaneLine(summary, archivedCount) : EMPTY_LINE), [archivedCount, summary]);
    const { nothingYet, holdWorkingPlace, managedUnavailable } = resolveWorkReadPresentation({
        projection, managedRuns: sources?.managedRuns ?? null, transcriptLoaded: useSessionTranscriptLoaded(props.sessionId),
        archivedLoading: archivedReports.loading,
    });
    // The invitation is for a Session that never started anything: an archived child is something it did.
    const nothingStarted = nothingYet && archivedCount === 0;
    const controlsAvailable = presented && stepRunId === null && !nothingYet;
    const selectWorkView = React.useCallback((next: 'list' | 'map'): CurrentSessionPresentationIntentResultV1 => {
        if (!controlsAvailable) return { status: 'unavailable' };
        if (next === view) return { status: 'unchanged' };
        if (next === 'map' && expandedMapTab) pane.closeDetailsTab(expandedMapTab.key);
        setView(next);
        return { status: 'applied' };
    }, [controlsAvailable, expandedMapTab, pane, view]);
    const openMapInDetails = React.useCallback((): CurrentSessionPresentationIntentResultV1 => {
        if (!controlsAvailable || !canExpandMap) return { status: 'unavailable' };
        pane.openDetailsTab(createSessionWorkMapDetailsTab({ sessionId: props.sessionId }), { intent: 'pinned' });
        return { status: 'applied' };
    }, [canExpandMap, controlsAvailable, pane, props.sessionId]);
    // List | Map: in the pane header beside the lead; full width at the top of a phone's pushed page,
    // whose nav bar holds only "+" and ⋯ (lab `convo-P1`). One rule for both widths: the switch exists only
    // while there is live work to list or map; an invitation or archived-only Session has nothing to switch.
    const phone = deviceType === 'phone';
    const viewTabs = (
        <SegmentedTabBar
            testIDPrefix="session-work-view"
            accessibilityLabel={t('sessionWork.view.a11y')}
            // The pane header's List | Map is the regular control (lab `convo-W2`), not the compact one:
            // its 10 px labels read smaller than every other word in the pane.
            segmentSizing={phone ? 'equal' : 'content'}
            tabs={[
                { id: 'list' as const, label: t('sessionWork.view.list') },
                { id: 'map' as const, label: t('sessionWork.view.map') },
            ]}
            activeTabId={view}
            onSelectTab={selectWorkView}
        />
    );
    const headerAction = React.useMemo(() => stepRunId ? null : (
        <View style={styles.headerActions}>
            {phone || nothingYet ? null : viewTabs}
            {/* ⤢ (lab `convo-W7`): the map at full size beside the transcript, where there is room. */}
            {canExpandMap && !nothingYet ? (
                <IconButton
                    testID="session-work-expand-map"
                    iconName="arrows-out"
                    variant="plain"
                    accessibilityLabel={t('sessionWork.view.expandMap')}
                    tooltip={t('sessionWork.view.expandMap')}
                    onPress={openMapInDetails}
                />
            ) : null}
            <View ref={addMenuAnchorRef} collapsable={false}>
                <SessionAgentsLaunchMenu
                    launcher={launcher}
                    onAddTrigger={openTriggers}
                    onKeepGoing={goalControlEntry.available ? goalControlEntry.open : null}
                    unavailableText={resolveUnavailableText(launcher, machineName)}
                />
            </View>
        </View>
    ), [canExpandMap, goalControlEntry, launcher, machineName, nothingYet, openMapInDetails, openTriggers, phone, selectWorkView, stepRunId, styles.headerActions, view]);
    const menuActions = useSessionWorkMenuActions({
        sessionId: props.sessionId, serverId: sessionServerId, hasReports,
    });
    // The lead this Session reports to is the pane's first fact, its "Managed by" row (lab P1w); the
    // header line says what is going on under it.
    const lineage = useSessionLineage(props.sessionId, sessionServerId);
    const manager = lineage.length > 0 ? lineage[lineage.length - 1]! : null;
    const openManager = React.useCallback(() => {
        if (manager) router.push(buildScopedSessionRouteHref({ sessionId: manager.sessionId, serverId: sessionServerId }) as never);
    }, [manager, router, sessionServerId]);
    const openPutUnder = React.useCallback(() => {
        showPutUnderSessionModal({ sessionId: props.sessionId, serverId: sessionServerId });
    }, [props.sessionId, sessionServerId]);
    const headerLine = React.useMemo(
        () => ({ segments: stepRunId ? [t('sessionWork.step.drivenBy')] : liveLine.length > 0 ? liveLine : [] }),
        // Nothing started says so once, in the pane's own empty state, not again in the header line.
        [liveLine, stepRunId],
    );
    usePaneHeaderSlotContent(React.useMemo(
        () => ({ line: headerLine, action: headerAction, menuActions }),
        [headerAction, headerLine, menuActions],
    ));

    const unavailableText = resolveUnavailableText(launcher, machineName);
    // The offline line's one Retry asks again for everything the pane reads: the machine's presence and the runs.
    const retryManagedRuns = sources?.managedRuns.retry;
    const retryOfflineWork = React.useCallback(() => {
        fireAndForget(retryMachineReachability(), { tag: 'SessionWorkView.retryMachineReachability' });
        retryManagedRuns?.();
    }, [retryManagedRuns]);
    const managedStale = sources?.managedRuns.phase === 'loaded' && sources.managedRuns.refreshFailed;
    const machineNotices = resolveWorkMachineNotices({ machineReachability, nothingYet, unavailableReason: launcher.unavailableReason, managedUnavailable, managedStale });
    // One list by state on every surface (INT r0.4 §6 I4, lab `convo-W1/W8full`, `phone-P5`).
    const previousStateGroups = React.useRef<Readonly<{ sessionId: string; serverId: string | null;
        groups: ReturnType<typeof groupWorkByState> }> | null>(null);
    const stateGroups = React.useMemo(() => {
        if (!projection) { previousStateGroups.current = null; return null; }
        const previous = previousStateGroups.current;
        const groups = groupWorkByState(projection, previous?.sessionId === props.sessionId && previous.serverId === sessionServerId ? previous.groups : null);
        previousStateGroups.current = { sessionId: props.sessionId, serverId: sessionServerId, groups };
        return groups;
    }, [projection, props.sessionId, sessionServerId]);
    const recentCount = stateGroups?.recent.length ?? 0;
    // The digest repeats a Session row only where the lab does: one that needs you. A Working or Recent
    // row the list above already shows is not drawn twice (the Map shows no rows, so there it is).
    const listedQuietSessionIds = React.useMemo(() => {
        const ids = new Set<string>();
        if (!stateGroups || (view === 'map' && workMap)) return ids;
        for (const item of [...stateGroups.working, ...stateGroups.recent]) {
            if (item.open.kind === 'session') ids.add(item.open.sessionId);
        }
        return ids;
    }, [stateGroups, view, workMap]);
    const showAllRecent = React.useCallback((): CurrentSessionPresentationIntentResultV1 => {
        if (!presented || view !== 'list' || recentCount === 0) return { status: 'unavailable' };
        if (recentExpanded || recentCount <= RECENT_COLLAPSED_ROWS) return { status: 'unchanged' };
        setRecentExpanded(true);
        return { status: 'applied' };
    }, [presented, recentCount, recentExpanded, view]);
    const recentDisclosure = React.useMemo(() => ({ expanded: recentExpanded, showAll: showAllRecent }), [recentExpanded, showAllRecent]);

    React.useLayoutEffect(() => {
        const address = normalizeSessionAddress(sessionServerId, props.sessionId);
        if (!presentationRef || !address || !presented) return;
        const binding: SessionWorkPresentationBinding = {
            address,
            apply: intent => {
                switch (intent.kind) {
                    case 'work.view.select': return selectWorkView(intent.view);
                    case 'work.recent.show_more': return showAllRecent();
                    case 'work.map.expand': return openMapInDetails();
                }
            },
        };
        presentationRef.current = binding;
        return () => {
            if (presentationRef.current === binding) presentationRef.current = null;
        };
    }, [openMapInDetails, presented, presentationRef, props.sessionId, selectWorkView, sessionServerId, showAllRecent]);
    // Rows named from one stem keep the words that tell them apart when the pane truncates them.
    const titleTailStartByKey = React.useMemo(() => {
        const items = stateGroups ? WORK_STATE_SECTIONS.flatMap((section) => stateGroups[section.key]) : [];
        const starts = resolveWorkTitleTailStarts(items.map((item) => item.title));
        const byKey = new Map<string, number>();
        items.forEach((item, index) => {
            const start = starts[index];
            if (start != null) byKey.set(item.key, start);
        });
        return byKey;
    }, [stateGroups]);
    const roster = React.useMemo<WorkRoster>(() => ({
        sessionId: props.sessionId,
        serverId: sessionServerId,
        session,
        sessionAgentId,
        rowByEntryId: agentRowByEntryId,
        activityPreviewById,
        originLabelById,
        onOpenItem: openItem,
        onShowItemInTranscript: showItemInTranscript,
        onOpenPreview: openSubagentPreview,
        onOpenFull: openSubagentFull,
        onOpenAdvanced: openSubagentAdvanced,
        onLaunchTeammate,
    }), [
        activityPreviewById, agentRowByEntryId, onLaunchTeammate, openItem, openSubagentAdvanced, openSubagentFull,
        openSubagentPreview, originLabelById, props.sessionId, session, sessionAgentId, sessionServerId, showItemInTranscript,
    ]);

    return (
        <View style={styles.container}>
            {machineNotices.offline ? (
                <SurfaceFreshnessLine
                    testID="session-work-machine-offline"
                    tone="warning"
                    // The rows below are the last known state: say from when, and offer the one Retry.
                    asOf={managedStale ? sources?.managedRuns.lastSuccessfulReadAt ?? machineLastSeenAt : machineLastSeenAt}
                    action={{ label: t('common.retry'), onPress: retryOfflineWork }}
                    reason={machineName
                        ? t('sessionAgentActivity.roster.machineOffline', { machine: machineName })
                        : t('sessionAgentActivity.roster.machineOfflineUnnamed')}
                />
            ) : session?.archivedAt != null && (projection?.summary.outstanding ?? 0) > 0 ? (
                <SurfaceFreshnessLine
                    testID="session-work-lead-archived"
                    reason={t('sessionWork.leadArchived', { count: projection?.summary.outstanding ?? 0 })}
                />
            ) : null}
            {machineNotices.runsStale && sources ? (
                <SurfaceFreshnessLine
                    testID="session-work-runs-stale"
                    tone="warning"
                    asOf={sources.managedRuns.lastSuccessfulReadAt}
                    reason={t('sessionWork.runsStale')}
                    action={{ label: t('common.retry'), onPress: sources.managedRuns.retry }}
                />
            ) : null}
            <WorkViewportContext.Provider value={workViewport.viewport}>
                <ScrollView
                    ref={scrollRef}
                    testID="session-work-scroll"
                    style={styles.scroll}
                    contentContainerStyle={[styles.content, { maxWidth: columnMaxWidth }, nothingStarted ? styles.contentEmpty : null]}
                    onScroll={workViewport.onScroll}
                    scrollEventThrottle={100}
                    onLayout={workViewport.onLayout}
                    onContentSizeChange={workViewport.onContentSizeChange}
                >
                    {stepRunId ? (
                        <>
                            {/* A workflow step (lab `session-F`): the run it is part of and why nothing is set
                                here; work the step itself started still lists inside its Work section. */}
                            <SessionStepWork runId={stepRunId} serverId={sessionServerId} machineName={machineName}>
                                {!nothingYet && stateGroups ? WORK_STATE_SECTIONS.map((section) => (
                            <WorkStateSection
                                key={section.key}
                                section={section}
                                disclosure={section.key === 'recent' ? recentDisclosure : undefined}
                                items={stateGroups[section.key]}
                                loading={false}
                                titleTailStartByKey={titleTailStartByKey}
                                roster={roster}
                            />
                        )) : undefined}
                            </SessionStepWork>
                        </>
                    ) : (<>
                    {phone && !nothingYet ? <View style={styles.phoneTabs}>{viewTabs}</View> : null}
                    {/* The top value rows (Managed by, Goal; lab P1w) lie flat on the pane (INT r0.4 §6 I4):
                        page `Item` rows on the flat sheet, on the list's inset. */}
                    <WorkFlatSheet testID="session-work-top">
                        {/* One row, always (lab P1w): its manager, which opens it; or Top level, which is where
                            Put under starts (the session menu's Put under… opens the same chooser). */}
                        <Item
                            testID="session-work-managed-by"
                            title={t('sessionWork.managedBy')}
                            detail={manager ? manager.title : t('entityDragDrop.keyboard.topLevel')}
                            density="compact"
                            onPress={manager ? openManager : openPutUnder}
                        />
                        {/* FIN 04's slot: the Goal row opens the one Goal control, the composer's. */}
                        <SessionGoalValueRow sessionId={props.sessionId} serverId={sessionServerId} entry={goalControlEntry} testID="session-work-goal" />
                        <SessionWorkPlanRow sessionId={props.sessionId} serverId={sessionServerId} />
                    </WorkFlatSheet>
                    <SessionAgentStartDraftRows sessionId={props.sessionId} serverId={sessionServerId} drafts={startDrafts} onOpen={openStartDraft} />
                    {machineNotices.runsUnavailable ? (
                        <SurfaceStateCard testID="session-work-runs-unavailable" size="line" kind="error"
                            title={t('common.unavailable')}
                            action={sources ? { label: t('common.retry'), onPress: sources.managedRuns.retry } : undefined} />
                    ) : null}
                    {/* With no work yet the invite stands where the list will be (lab `convo-ST`). */}
                    {nothingStarted ? (
                        <View style={styles.empty}>
                            {/* The invite (lab `convo-ST`, "Nothing started yet"): the Agents that can take work
                                here, one way to start and the asks. Without a way to start, the plain empty. */}
                            {launcher.unavailableReason === null ? (
                                <SurfaceStateCard
                                    testID="session-work-empty"
                                    kind="empty"
                                    icon={launcher.agentIds.length > 0 ? (
                                        <View style={styles.marks}>
                                            {launcher.agentIds.slice(0, 3).map((agentId) => (
                                                <ExecutionRunAgentMark key={agentId} agentId={agentId} size={30} />
                                            ))}
                                        </View>
                                    ) : <Icon name="tree-structure" size={28} color={theme.colors.text.secondary} />}
                                    title={t('sessionAgentActivity.roster.empty.title')}
                                    reason={machineName
                                        ? t('sessionAgentActivity.roster.empty.reason', { machine: machineName })
                                        : t('sessionAgentActivity.roster.empty.reasonUnnamed')}
                                    action={{ label: t('session.subagents.panel.newAgentConversation'), onPress: launcher.openConversation }}
                                />
                            ) : null}
                            {launcher.unavailableReason === null ? <WorkInviteAsks launcher={launcher} /> : (
                                <SurfaceStateCard
                                    testID="session-work-empty"
                                    kind="empty"
                                    icon={<Icon name="tree-structure" size={28} color={theme.colors.text.secondary} />}
                                    title={t('sessionWork.empty.title')}
                                    // One message per state: why nothing can start here, with its way out,
                                    // replaces the general description instead of stacking under it.
                                    reason={unavailableText ?? t('sessionWork.empty.reason')}
                                />
                            )}
                        </View>
                    ) : view === 'map' && workMap && projection ? (
                        <SessionWorkMapView map={workMap} projection={projection} showFacts={false} testIDPrefix="session-work-map" onOpenItem={openItem} />
                    ) : stateGroups ? (
                        WORK_STATE_SECTIONS.map((section) => (
                            <WorkStateSection
                                key={section.key}
                                section={section}
                                disclosure={section.key === 'recent' ? recentDisclosure : undefined}
                                items={stateGroups[section.key]}
                                // Workflow runs are still arriving and nothing else is shown: Working keeps
                                // its place instead of claiming nothing is going.
                                loading={section.key === 'working' && holdWorkingPlace}
                                titleTailStartByKey={titleTailStartByKey}
                                roster={roster}
                            />
                        ))
                    ) : null}
                    {/* After the list, as the lab's coordinator Work ends (P1 `W_COORD`): what the work adds up to. */}
                    {isCoordinator ? (
                        <SessionWorkDigest sessionId={props.sessionId} serverId={sessionServerId} sessionItemById={sessionItemById} listedQuietSessionIds={listedQuietSessionIds} onOpenItem={openItem} />
                    ) : null}
                    {unavailableText && machineNotices.unavailable ? (
                        <SurfaceStateCard
                            testID="session-work-unavailable"
                            size="line"
                            kind="denied"
                            title={unavailableText}
                        />
                    ) : null}
                    {/* The session's Triggers live with its work (07 S16, lab W9); "+" and rows open popovers in place. */}
                    {sessionServerId ? (
                        <View collapsable={false} onLayout={onTriggersLayout} style={styles.paneEdgeSection}>
                            <SessionHabitsSection sessionId={props.sessionId} serverId={sessionServerId} actionsRef={triggersActionsRef} />
                        </View>
                    ) : null}
                    </>)}
                </ScrollView>
            </WorkViewportContext.Provider>
        </View>
    );
});

const INVITE_ASKS = ['review', 'plan', 'delegate'] as const;

/**
 * The invite's other ways to start (lab `convo-ST`, "Or ask for a Review · Plan · Delegate"): each ask
 * this Session's backends can take, opening the same composer-first start as the "+" menu.
 */
const WorkInviteAsks = React.memo(function WorkInviteAsks(props: Readonly<{ launcher: SessionAgentLauncher }>) {
    const { launcher } = props;
    const asks = INVITE_ASKS.filter((intent) => launcher.intents.includes(intent));
    if (asks.length === 0) return null;
    return (
        <Text testID="session-work-invite-asks" style={inviteStyles.line}>
            {`${t('sessionWork.invite.orAskFor')} `}
            {asks.map((intent, index) => (
                <React.Fragment key={intent}>
                    {index > 0 ? <Text style={inviteStyles.separator}>{' · '}</Text> : null}
                    <Text
                        testID={`session-work-invite-ask:${intent}`}
                        accessibilityRole="link"
                        style={inviteStyles.link}
                        onPress={() => launcher.openRun(intent)}
                    >
                        {t(`executionRuns.newRun.intents.${intent}`)}
                    </Text>
                </React.Fragment>
            ))}
        </Text>
    );
});

const inviteStyles = StyleSheet.create((theme) => ({
    line: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
        textAlign: 'center',
        marginTop: -8,
    },
    separator: {
        color: theme.colors.text.tertiary,
    },
    link: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));

type WorkStateSectionSpec = Readonly<{
    key: keyof WorkStateGroups;
    /** "Needs you" and "Working" are the shared bucket labels; "Recent" is the Work list's own group. */
    title: () => string;
    countMode: 'attention' | 'quiet' | 'none';
    /** Rows shown before "Show N more" (lab `convo-W2`: Recent stays short); null shows every row. */
    collapsedRows: number | null;
}>;

const RECENT_COLLAPSED_ROWS = 4;
const WORK_STATE_SECTIONS: readonly WorkStateSectionSpec[] = [
    { key: 'needsYou', title: () => describeWorkStatusBucket('needs_you'), countMode: 'attention', collapsedRows: null },
    { key: 'working', title: () => describeWorkStatusBucket('working'), countMode: 'quiet', collapsedRows: null },
    { key: 'recent', title: () => t('sessionWork.states.recent'), countMode: 'none', collapsedRows: RECENT_COLLAPSED_ROWS },
    // Sessions this one led and archived: after everything live, short, each with its Unarchive.
    { key: 'archived', title: () => t('sessionWork.states.archived'), countMode: 'quiet', collapsedRows: 3 },
];

/** What a state section needs to draw each item through its own row. */
type WorkRoster = Readonly<{
    sessionId: string;
    serverId: string | null;
    session: Session | null;
    sessionAgentId: string | null;
    rowByEntryId: ReadonlyMap<string, SessionAgentActivityRow>;
    activityPreviewById: ReadonlyMap<string, string>;
    originLabelById: ReadonlyMap<string, string>;
    onOpenItem: (item: WorkItem) => void;
    onShowItemInTranscript: (item: WorkItem) => void;
    onOpenPreview: (subagent: SessionSubagent) => void;
    onOpenFull: (subagent: SessionSubagent) => void;
    onOpenAdvanced: (subagent: SessionSubagent) => void;
    onLaunchTeammate: ((teamId: string) => void) | null;
}>;

type WorkStateSegment =
    | Readonly<{ kind: 'item'; item: WorkItem }>
    | Readonly<{ kind: 'roster'; key: string; rows: readonly SessionAgentActivityRow[] }>;

/**
 * Sessions and workflow runs draw as Work rows; background runs and in-session agents keep their roster
 * rows (their controls — stop, open full, advanced — live on the row's menu, and a Claude team groups
 * its agents under one line). Consecutive roster items share one segment so a team stays together.
 */
function segmentWorkItems(
    items: readonly WorkItem[],
    rowByEntryId: ReadonlyMap<string, SessionAgentActivityRow>,
): readonly WorkStateSegment[] {
    const segments: WorkStateSegment[] = [];
    let rosterRows: SessionAgentActivityRow[] | null = null;
    for (const item of items) {
        const row = item.open.kind === 'agent_activity' ? rowByEntryId.get(item.open.entryId) : undefined;
        if (row) {
            if (!rosterRows) {
                rosterRows = [];
                segments.push({ kind: 'roster', key: `roster:${item.key}`, rows: rosterRows });
            }
            rosterRows.push(row);
            continue;
        }
        rosterRows = null;
        segments.push({ kind: 'item', item });
    }
    return segments;
}

const WorkStateSection = React.memo(function WorkStateSection(props: Readonly<{
    section: WorkStateSectionSpec;
    items: readonly WorkItem[];
    loading: boolean;
    titleTailStartByKey: ReadonlyMap<string, number>;
    roster: WorkRoster;
    disclosure?: Readonly<{ expanded: boolean; showAll: () => void }>;
}>) {
    const workTheme = useWorkTheme();
    const { section, items, roster } = props;
    const [localExpanded, setExpanded] = React.useState(false);
    const expanded = props.disclosure?.expanded ?? localExpanded;
    const limit = section.collapsedRows;
    const hiddenCount = limit !== null && !expanded ? Math.max(0, items.length - limit) : 0;
    const visibleItems = hiddenCount > 0 && limit !== null ? items.slice(0, limit) : items;
    const segments = React.useMemo(
        () => segmentWorkItems(visibleItems, roster.rowByEntryId),
        [roster.rowByEntryId, visibleItems],
    );
    const showAll = React.useCallback(() => setExpanded(true), []);
    if (items.length === 0 && !props.loading) return null;

    return (
        <WorkSection
            testID={`session-work-state-${section.key}`}
            title={section.title()}
            count={items.length}
            countMode={section.countMode}
            loading={props.loading}
        >
            {segments.map((segment) => (
                segment.kind === 'item' ? (
                    <WorkItemRow
                        key={segment.item.key}
                        item={segment.item}
                        titleTailStart={props.titleTailStartByKey.get(segment.item.key)}
                        trailingAccessory={section.key === 'archived' && segment.item.open.kind === 'session' ? (
                            <WorkRowUnarchive sessionId={segment.item.open.sessionId} serverId={roster.serverId} title={segment.item.title} />
                        ) : undefined}
                        onOpen={roster.onOpenItem}
                        onShowInTranscript={roster.onShowItemInTranscript}
                    />
                ) : groupSessionSubagents(segment.rows).map((group) => (
                    <SessionSubagentGroup
                        key={`${segment.key}:${group.key}`}
                        sessionId={roster.sessionId}
                        serverId={roster.serverId}
                        session={roster.session}
                        sessionAgentId={roster.sessionAgentId}
                        label={group.label}
                        rows={group.items}
                        activityPreviewById={roster.activityPreviewById}
                        originLabelById={roster.originLabelById}
                        onOpenPreview={roster.onOpenPreview}
                        onOpenFull={roster.onOpenFull}
                        onOpenAdvanced={roster.onOpenAdvanced}
                        onLaunchTeammate={roster.onLaunchTeammate}
                    />
                ))
            ))}
            {hiddenCount > 0 ? (
                <HappierWorkDisclosureLine
                    testID={`session-work-state-${section.key}-more`}
                    label={t('sessionWork.showMore', { count: hiddenCount })}
                    onPress={props.disclosure?.showAll ?? showAll}
                    theme={workTheme}
                    host={WORK_HOST}
                />
            ) : null}
        </WorkSection>
    );
});

const EMPTY_SUBAGENTS: readonly SessionSubagent[] = Object.freeze([]);
const EMPTY_LINE: ReturnType<typeof describeWorkPaneLine> = [];
const NO_SESSION_ADDRESSES: readonly SessionAddress[] = [];
const EMPTY_ROWS: ReturnType<typeof readSessionAgentActivityRows> = Object.freeze([]);
