import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { SessionRoleValueRow, isSessionRoleSnapshotCopiedAcrossOwners } from '@/components/roles/session/sessionRole';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { SessionAgentsLaunchMenu } from '@/components/sessions/agents/launch/SessionAgentsLaunchMenu';
import { useSessionGoalControlEntry } from '@/components/sessions/workState/openSessionGoalControl';
import { SessionGoalValueRow } from '@/components/sessions/workState/SessionGoalControlContent';
import { SessionAgentStartDraftRows } from '@/components/sessions/agents/launch/SessionAgentStartDraftRows';
import { projectAgentStartDrafts } from '@/components/sessions/agents/launch/agentStartDrafts';
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

import { useSessionWorkSources } from './sessionWorkSources';
import { useSessionWorkMap } from './useSessionWorkMap';
import { SessionWorkMapView } from './SessionWorkMapView';
import { SessionNotesSection } from './roles/SessionNotesSection';
import { SessionInstructionsSection } from './instructions/SessionInstructionsSection';
import { SessionVoiceSection } from './voice/SessionVoiceSection';
import { SessionMemorySection } from './memory/SessionMemorySection';
import { SessionContextSection } from './context/SessionContextSection';
import { SessionRolesSection } from './roles/SessionRolesSection';
import { useSessionWorkMenuActions } from './sessionWorkMenuActions';
import { describeSessionLineage, useSessionLineage } from './sessionLineage';
import { SessionLineageNavigation } from './SessionLineageBreadcrumb';
import { createSessionWorkMapDetailsTab } from './SessionWorkMapDetailsView';
import { WorkItemRow, WorkViewportContext, useWorkScrollViewport } from './WorkItemRow';
import { SessionWorkNotifications } from './SessionWorkNotifications';
import { readSessionWorkflowStepRunId, SessionStepWork } from './SessionStepWork';
import { describeWorkPaneLine } from './workPaneLine';
import { WorkFlatSheet, WorkSection } from './WorkSection';
import {
    groupWorkByState, resolveWorkReadPresentation, resolveWorkTitleTailStarts,
    type WorkItem, type WorkStateGroups,
} from './workProjection';

/**
 * The Session's Work tab (ORC §3.8; lab `session-A`, `session-G`, `session-S`).
 *
 * One pane for everything this Session leads: the Sessions under it (the `reportsTo` tree), the
 * workflows and background runs it started, and the agents working inside it — read from the ONE Work
 * projection its Session host mounted, so the pane, the header strip and "never Finished" agree.
 *
 * Rows state where each item stands and open its peek; they carry no answer controls (S-1). The Goal
 * control, Roles for this session and Triggers are owned by FIN 04, lane U2 and FIN; this pane only
 * hosts them in their slots (Roles and the Goal row are mounted here — the row opens FIN 04's one Goal
 * control, the composer's; Triggers arrives as a prop).
 */

export const SESSION_WORK_TRIGGERS_ANCHOR_ID = 'session-work-triggers';

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
    content: {
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
    slot: {
        paddingHorizontal: 0,
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
    /** FIN's session Triggers section, in its slot (`/session/[id]/triggers` scrolls here). */
    triggersSection?: React.ReactNode;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const session = useSessionViewShellSession(props.sessionId, props.serverId);
    const sessionServerId = props.serverId ?? session?.serverId ?? null;
    const inheritedFrom = readSessionRolesV1(session?.metadata)?.inheritedFrom ?? '';
    const inheritedLead = useSessionViewShellSession(inheritedFrom, sessionServerId);
    const accountScope = useActiveServerAccountScope();
    const accountId = accountScope && sessionServerId && areServerProfileIdentifiersEquivalent(accountScope.serverId, sessionServerId)
        ? accountScope.accountId : null;
    const copiedAtSpawn = isSessionRoleSnapshotCopiedAcrossOwners(session, inheritedLead, accountId);
    const sources = useSessionWorkSources();
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
    const { machineReachable } = useSessionMachineReachability(props.sessionId, sessionServerId);
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
    const [view, setView] = React.useState<'list' | 'map'>('list');
    const { map: workMap, openItem, showItemInTranscript, openSubagentPreview, openSubagentFull, openSubagentAdvanced } = useSessionWorkMap({
        sessionId: props.sessionId,
        serverId: sessionServerId,
        scopeId: props.scopeId,
        subagents,
        session,
        projection,
        active: view === 'map',
    });

    const pane = useAppPaneScope(props.scopeId);
    const openMapInDetails = React.useCallback(() => {
        pane.openDetailsTab(createSessionWorkMapDetailsTab({ sessionId: props.sessionId }), { intent: 'pinned' });
    }, [pane, props.sessionId]);
    const canExpandMap = deviceType !== 'phone';
    // "Add a trigger…" (the "+" menu) brings this Session's Triggers section into view; it is
    // offered only while that section is mounted here.
    const scrollRef = React.useRef<ScrollView>(null);
    const triggersOffsetRef = React.useRef<number | null>(null);
    const hasTriggersSection = Boolean(props.triggersSection);
    const scrollToTriggers = React.useCallback(() => {
        const y = triggersOffsetRef.current;
        if (y !== null) scrollRef.current?.scrollTo({ y, animated: true });
    }, []);
    const onTriggersLayout = React.useCallback((event: LayoutChangeEvent) => {
        triggersOffsetRef.current = event.nativeEvent.layout.y;
    }, []);
    // Rows that carry live content (a working run's mini-map) mount it only while on screen here.
    const workViewport = useWorkScrollViewport(scrollRef);
    // Unsent starts open beside the Session lead the list until their first Send (the Start row).
    const startDrafts = React.useMemo(() => projectAgentStartDrafts(pane.scopeState?.details), [pane.scopeState?.details]);
    const setActiveDetailsTab = pane.setActiveDetailsTab;
    const hasReports = (projection?.summary.sessions ?? 0) > 0;
    // List | Map: in the pane header beside the lead; full width at the top of a phone's pushed page,
    // whose nav bar holds only "+" and ⋯ (lab `convo-P1`).
    const phone = deviceType === 'phone';
    const viewTabs = (
        <SegmentedTabBar
            testIDPrefix="session-work-view"
            accessibilityLabel={t('sessionWork.view.a11y')}
            compact={!phone}
            segmentSizing={phone ? 'equal' : 'content'}
            tabs={[
                { id: 'list' as const, label: t('sessionWork.view.list') },
                { id: 'map' as const, label: t('sessionWork.view.map') },
            ]}
            activeTabId={view}
            onSelectTab={setView}
        />
    );
    // A workflow step's checks are the workflow's (lab `session-F`): no List | Map, ⤢ or "+".
    const stepRunId = readSessionWorkflowStepRunId(session);
    const headerAction = React.useMemo(() => stepRunId ? null : (
        <View style={styles.headerActions}>
            {phone ? null : viewTabs}
            {/* ⤢ (lab `convo-W7`): the map at full size beside the transcript, where there is room. */}
            {canExpandMap ? (
                <IconButton
                    testID="session-work-expand-map"
                    iconName="arrows-out"
                    variant="plain"
                    accessibilityLabel={t('sessionWork.view.expandMap')}
                    tooltip={t('sessionWork.view.expandMap')}
                    onPress={openMapInDetails}
                />
            ) : null}
            <SessionAgentsLaunchMenu
                launcher={launcher}
                onAddTrigger={hasTriggersSection ? scrollToTriggers : null}
                onKeepGoing={goalControlEntry.available ? goalControlEntry.open : null}
                unavailableText={resolveUnavailableText(launcher, machineName)}
            />
        </View>
    ), [canExpandMap, goalControlEntry, hasTriggersSection, launcher, machineName, openMapInDetails, phone, scrollToTriggers, stepRunId, styles.headerActions, view]);
    const menuActions = useSessionWorkMenuActions({
        sessionId: props.sessionId, serverId: sessionServerId, hasReports,
    });
    const summary = projection?.summary ?? null;
    const liveLine = React.useMemo(() => (summary ? describeWorkPaneLine(summary) : EMPTY_LINE), [summary]);
    const { nothingYet, holdWorkingPlace, managedUnavailable } = resolveWorkReadPresentation({
        projection, managedRuns: sources?.managedRuns ?? null, transcriptLoaded: useSessionTranscriptLoaded(props.sessionId),
    });
    // A Session that reports to a lead says so first (lab `session-E`: "Reports to Payments v2 rollout").
    const lineage = useSessionLineage(props.sessionId, sessionServerId);
    const lineageDescription = describeSessionLineage(lineage);
    const headerLine = React.useMemo(
        () => lineage.length > 0 && deviceType === 'phone'
            ? { leading: <SessionLineageNavigation lineage={lineage} serverId={sessionServerId} presentation="reportsTo" />, segments: [] }
            : { segments: stepRunId ? [t('sessionWork.step.drivenBy')] : lineageDescription ? [lineageDescription] : liveLine.length > 0 ? liveLine : nothingYet ? [t('sessionWork.subtitle.nothingStarted')] : [] },
        [deviceType, lineageDescription, lineage, liveLine, sessionServerId, nothingYet, stepRunId],
    );
    usePaneHeaderSlotContent(React.useMemo(
        () => ({ line: headerLine, action: headerAction, menuActions }),
        [headerAction, headerLine, menuActions],
    ));

    const unavailableText = resolveUnavailableText(launcher, machineName);
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

    // The Session's guidance sections lead the configuration. A Bot reads Instructions · Memory · Voice ·
    // Triggers (plan 65, D44), so the Context it inherits follows its Triggers; an ordinary Session keeps
    // Context beside the Memory it reads (lab `c-mem O`).
    const isBot = readSessionBotV1(session?.metadata?.bot)?.kind === 'bot';
    const contextSection = session && sessionServerId
        ? <SessionContextSection session={session} serverId={sessionServerId} />
        : null;
    const guidanceSections = session && sessionServerId ? (
        <>
            <SessionInstructionsSection session={session} serverId={sessionServerId} />
            <SessionMemorySection session={session} serverId={sessionServerId} />
            {isBot ? null : contextSection}
            <SessionVoiceSection session={session} serverId={sessionServerId} />
        </>
    ) : null;
    const triggersSlot = props.triggersSection ? (
        <View testID="session-work-triggers-slot" nativeID={SESSION_WORK_TRIGGERS_ANCHOR_ID} style={styles.slot} onLayout={onTriggersLayout}>
            {props.triggersSection}
        </View>
    ) : null;

    return (
        <View style={styles.container}>
            {!machineReachable && !nothingYet ? (
                <SurfaceFreshnessLine
                    testID="session-work-machine-offline"
                    tone="warning"
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
            {sources?.managedRuns.refreshFailed && sources.managedRuns.phase === 'loaded' ? (
                <SurfaceFreshnessLine
                    testID="session-work-runs-stale"
                    tone="warning"
                    reason={t('sessionWork.runsStale')}
                    action={{ label: t('common.retry'), onPress: sources.managedRuns.retry }}
                />
            ) : null}
            <WorkViewportContext.Provider value={workViewport.viewport}>
                <ScrollView
                    ref={scrollRef}
                    testID="session-work-scroll"
                    style={styles.scroll}
                    contentContainerStyle={[styles.content, nothingYet ? styles.contentEmpty : null]}
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
                                items={stateGroups[section.key]}
                                loading={false}
                                titleTailStartByKey={titleTailStartByKey}
                                roster={roster}
                            />
                        )) : undefined}
                            </SessionStepWork>
                            <WorkFlatSheet testID="session-work-top">
                                <SessionWorkNotifications sessionId={props.sessionId} serverId={sessionServerId} />
                            </WorkFlatSheet>
                            {guidanceSections}
                            {isBot ? contextSection : null}
                        </>
                    ) : (<>
                    {phone && !nothingYet ? <View style={styles.phoneTabs}>{viewTabs}</View> : null}
                    {/* The top value rows (Role, Goal; lab `convo-W8full`) lie flat on the pane like the
                        sections below (INT r0.4 §6 I4): page `Item` rows on the flat sheet, on the list's inset. */}
                    <WorkFlatSheet testID="session-work-top">
                        <SessionRoleValueRow sessionId={props.sessionId} serverId={sessionServerId} testID="session-work-role" />
                        {/* FIN 04's slot: the Goal row opens the one Goal control, the composer's. */}
                        <SessionGoalValueRow sessionId={props.sessionId} entry={goalControlEntry} testID="session-work-goal" />
                        <SessionWorkNotifications sessionId={props.sessionId} serverId={sessionServerId} />
                    </WorkFlatSheet>
                    <SessionAgentStartDraftRows drafts={startDrafts} onOpen={setActiveDetailsTab} />
                    {managedUnavailable ? (
                        <SurfaceStateCard testID="session-work-runs-unavailable" size="line" kind="error"
                            title={t('common.unavailable')}
                            action={sources ? { label: t('common.retry'), onPress: sources.managedRuns.retry } : undefined} />
                    ) : null}
                    {/* With no work yet, Triggers is what the Session can set up first, then the invite
                        (lab `convo-ST`). The Session's guidance follows the invite, as it follows the list. */}
                    {nothingYet ? triggersSlot : null}
                    {nothingYet ? (
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
                        <SessionWorkMapView map={workMap} projection={projection} testIDPrefix="session-work-map" onOpenItem={openItem} />
                    ) : stateGroups ? (
                        WORK_STATE_SECTIONS.map((section) => (
                            <WorkStateSection
                                key={section.key}
                                section={section}
                                items={stateGroups[section.key]}
                                // Workflow runs are still arriving and nothing else is shown: Working keeps
                                // its place instead of claiming nothing is going.
                                loading={section.key === 'working' && holdWorkingPlace}
                                titleTailStartByKey={titleTailStartByKey}
                                roster={roster}
                            />
                        ))
                    ) : null}
                    {unavailableText && !nothingYet ? (
                        <SurfaceStateCard
                            testID="session-work-unavailable"
                            size="line"
                            kind="denied"
                            title={unavailableText}
                        />
                    ) : null}
                    {/* The configuration sections under the live list, each opened by its own full-width
                        hairline (`WorkSection anatomy="page"`): Triggers, then Roles (and Notes). */}
                    {guidanceSections}
                    {nothingYet ? null : triggersSlot}
                    {isBot ? contextSection : null}
                    <View testID="session-work-roles-slot" style={styles.slot}>
                        {/* Lane U2's section. */}
                        <SessionRolesSection sessionId={props.sessionId} serverId={sessionServerId} copiedAtSpawn={copiedAtSpawn} />
                    </View>
                    <SessionNotesSection sessionId={props.sessionId} serverId={sessionServerId} />
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

const WORK_STATE_SECTIONS: readonly WorkStateSectionSpec[] = [
    { key: 'needsYou', title: () => describeWorkStatusBucket('needs_you'), countMode: 'attention', collapsedRows: null },
    { key: 'working', title: () => describeWorkStatusBucket('working'), countMode: 'quiet', collapsedRows: null },
    { key: 'recent', title: () => t('sessionWork.states.recent'), countMode: 'none', collapsedRows: 4 },
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
}>) {
    const workTheme = useWorkTheme();
    const { section, items, roster } = props;
    const [expanded, setExpanded] = React.useState(false);
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
                    onPress={showAll}
                    theme={workTheme}
                    host={WORK_HOST}
                />
            ) : null}
        </WorkSection>
    );
});

const EMPTY_SUBAGENTS: readonly SessionSubagent[] = Object.freeze([]);
const EMPTY_LINE: ReturnType<typeof describeWorkPaneLine> = [];
const EMPTY_ROWS: ReturnType<typeof readSessionAgentActivityRows> = Object.freeze([]);
