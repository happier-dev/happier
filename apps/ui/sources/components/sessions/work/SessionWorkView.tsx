import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { SessionRoleValueRow, isSessionRoleSnapshotCopiedAcrossOwners } from '@/components/roles/session/sessionRole';
import { readSessionRolesV1 } from '@happier-dev/protocol';
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
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useSessionTranscriptLoaded } from '@/sync/store/hooks';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { HappierPressable, HAPPIER_WORK_PANE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { describeWorkStatusBucket } from '@/components/work/status/workStatusBuckets';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { useSessionWorkSources } from './sessionWorkSources';
import { useSessionWorkOpeners } from './useSessionWorkOpeners';
import { SessionWorkMapView } from './SessionWorkMapView';
import { SessionNotesSection } from './roles/SessionNotesSection';
import { SessionRolesSection } from './roles/SessionRolesSection';
import { SessionWorkMoreMenu } from './SessionWorkMoreMenu';
import { createSessionWorkMapDetailsTab } from './SessionWorkMapDetailsView';
import { projectSessionWorkMap } from './workMapProducer';
import { WorkItemRow, WorkViewportContext, useWorkScrollViewport } from './WorkItemRow';
import { SessionWorkNotifications } from './SessionWorkNotifications';
import { WorkFlatSheet, WorkSection } from './WorkSection';
import { groupWorkByState, resolveWorkReadPresentation, type WorkItem, type WorkProjection, type WorkStateGroups } from './workProjection';

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
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
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

function readSubtitle(projection: WorkProjection): string | null {
    const { sessions, runs } = projection.summary;
    const segments: string[] = [];
    if (sessions > 0) segments.push(t('sessionWork.subtitle.sessions', { count: sessions }));
    if (runs > 0) segments.push(t('sessionWork.subtitle.runs', { count: runs }));
    return segments.length > 0 ? segments.join(' · ') : null;
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

    const leadTitle = session ? getSessionName(session, sessionServerId) : '';
    const leadAgentId = sessionAgentId;
    const { openItem, openSubagentPreview, openSubagentFull, openSubagentAdvanced } = useSessionWorkOpeners({
        sessionId: props.sessionId,
        serverId: sessionServerId,
        scopeId: props.scopeId,
        subagents,
        leadTitle,
    });

    // List | Map is a view of the same work, remembered only while the pane lives.
    const [view, setView] = React.useState<'list' | 'map'>('list');
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
    const headerAction = React.useMemo(() => (
        <View style={styles.headerActions}>
            <SegmentedTabBar
                testIDPrefix="session-work-view"
                accessibilityLabel={t('sessionWork.view.a11y')}
                compact
                segmentSizing="content"
                tabs={[
                    { id: 'list' as const, label: t('sessionWork.view.list') },
                    { id: 'map' as const, label: t('sessionWork.view.map') },
                ]}
                activeTabId={view}
                onSelectTab={setView}
            />
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
            />
            <SessionWorkMoreMenu sessionId={props.sessionId} serverId={sessionServerId} hasReports={hasReports} />
        </View>
    ), [canExpandMap, goalControlEntry, hasReports, hasTriggersSection, launcher, openMapInDetails, props.sessionId, sessionServerId, scrollToTriggers, styles.headerActions, view]);
    const subtitle = projection ? readSubtitle(projection) : null;
    const { nothingYet, managedLoading, managedUnavailable } = resolveWorkReadPresentation({
        projection, managedRuns: sources?.managedRuns ?? null, transcriptLoaded: useSessionTranscriptLoaded(props.sessionId),
    });
    const headerLine = React.useMemo(
        () => ({ segments: subtitle ? [subtitle] : nothingYet ? [t('sessionWork.subtitle.nothingStarted')] : [] }),
        [nothingYet, subtitle],
    );
    usePaneHeaderSlotContent(React.useMemo(() => ({ line: headerLine, action: headerAction }), [headerAction, headerLine]));

    const unavailableText = resolveUnavailableText(launcher, machineName);
    const workMap = React.useMemo(
        () => (view === 'map' && projection
            ? projectSessionWorkMap({ leadSessionId: props.sessionId, leadTitle, leadAgentId, projection })
            : null),
        [leadAgentId, leadTitle, projection, props.sessionId, view],
    );
    // One list by state on every surface (INT r0.4 §6 I4, lab `convo-W1/W8full`, `phone-P5`).
    const stateGroups = React.useMemo(() => (projection ? groupWorkByState(projection) : null), [projection]);
    const roster = React.useMemo<WorkRoster>(() => ({
        sessionId: props.sessionId,
        serverId: sessionServerId,
        session,
        sessionAgentId,
        rowByEntryId: agentRowByEntryId,
        activityPreviewById,
        originLabelById,
        onOpenItem: openItem,
        onOpenPreview: openSubagentPreview,
        onOpenFull: openSubagentFull,
        onOpenAdvanced: openSubagentAdvanced,
        onLaunchTeammate,
    }), [
        activityPreviewById, agentRowByEntryId, onLaunchTeammate, openItem, openSubagentAdvanced, openSubagentFull,
        openSubagentPreview, originLabelById, props.sessionId, session, sessionAgentId, sessionServerId,
    ]);

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
                    {/* With no work yet, Triggers is what the Session can set up first (lab `convo-ST`). */}
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
                                    secondaryAction={{ label: t('sessionAgentActivity.roster.empty.moreWays'), onPress: () => launcher.openRun('review') }}
                                />
                            ) : (
                                <SurfaceStateCard
                                    testID="session-work-empty"
                                    kind="empty"
                                    icon={<Icon name="tree-structure" size={28} color={theme.colors.text.secondary} />}
                                    title={t('sessionWork.empty.title')}
                                    reason={t('sessionWork.empty.reason')}
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
                                // Workflow runs are still arriving: Working keeps its place instead of
                                // claiming nothing is going.
                                loading={section.key === 'working' && managedLoading && stateGroups.working.length === 0}
                                roster={roster}
                            />
                        ))
                    ) : null}
                    {unavailableText ? (
                        <SurfaceStateCard
                            testID="session-work-unavailable"
                            size="line"
                            kind="denied"
                            title={unavailableText}
                        />
                    ) : null}
                    {/* The configuration sections under the live list, each opened by its own full-width
                        hairline (`WorkSection anatomy="page"`): Triggers, then Roles (and Notes). */}
                    {nothingYet ? null : triggersSlot}
                    <View testID="session-work-roles-slot" style={styles.slot}>
                        {/* Lane U2's section. */}
                        <SessionRolesSection sessionId={props.sessionId} serverId={sessionServerId} copiedAtSpawn={copiedAtSpawn} />
                    </View>
                    <SessionNotesSection sessionId={props.sessionId} serverId={sessionServerId} />
                </ScrollView>
            </WorkViewportContext.Provider>
        </View>
    );
});

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
    roster: WorkRoster;
}>) {
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
                    <WorkItemRow key={segment.item.key} item={segment.item} onOpen={roster.onOpenItem} />
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
                <HappierPressable
                    testID={`session-work-state-${section.key}-more`}
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionWork.showMore', { count: hiddenCount })}
                    onPress={showAll}
                    style={stateSectionStyles.more}
                >
                    <Text style={stateSectionStyles.moreText}>{t('sessionWork.showMore', { count: hiddenCount })}</Text>
                </HappierPressable>
            ) : null}
        </WorkSection>
    );
});

const stateSectionStyles = StyleSheet.create((theme) => ({
    // Quiet, under the rows' titles (past the 30px mark and its 10px gap).
    more: {
        minHeight: 32,
        justifyContent: 'center',
        paddingLeft: HAPPIER_WORK_PANE_METRICS.rowInsetPx + 40,
    },
    moreText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 12.5,
        lineHeight: 16,
    },
}));

const EMPTY_SUBAGENTS: readonly SessionSubagent[] = Object.freeze([]);
const EMPTY_ROWS: ReturnType<typeof readSessionAgentActivityRows> = Object.freeze([]);
