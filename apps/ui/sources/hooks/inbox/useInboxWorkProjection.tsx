import * as React from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { SessionAttentionStanding } from '@happier-dev/protocol/sessions/organization/standings';
import { useActivityOverview } from '@/activity/source/useActivityOverview';
import { readActivitySourceAttentionMessages } from '@/activity/source/buildActivityOverviewFromSource';
import { buildInboxSessionPresentation, type InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import { buildInboxWorkGroups, type InboxWorkGroup } from '@/activity/presentation/buildInboxWorkGroups';
import { readSessionWorkStalled } from '@/components/work/status/sessionWorkStatusFacts';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useWorkflowRunRows, useSessionOrganizationProjections, useMachineDisplayById } from '@/sync/domains/state/storage';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { projectSessionWorkspaceColors } from '@/sync/domains/session/organization/projectWorkspaceColors';
import { readSessionAppearanceWorkspaceKey } from '@/sync/domains/session/organization/appearanceWorkspaceKey';
import { createEffectiveSessionAppearanceColorsSelector } from '@/sync/store/selectors/sessionAppearance';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { useInboxPluginSessionRows } from './useInboxPluginSessionRows';
import { InboxExecutionRunSourceBoundary, useInboxExecutionRunSource } from './useInboxExecutionRunSource';
import { InboxArtifactSourceBoundary, useInboxArtifactRowDemand, useInboxArtifactSource } from './useInboxArtifactSource';
import { useFullWorkflowAttentionSource, useAutomationAttentionSource, WorkflowAttentionSourceBoundary } from './useWorkflowAttentionSource';

/**
 * The server origin link of a step session (ORC §3.1: awareness `origin?: {kind, runId?}`). U4 has
 * not landed it on the awareness schema yet; until then this reads nothing and nothing folds.
 */
function readAwarenessOriginRunId(entry: InboxSessionAttentionEntry): string | null {
    const origin: unknown = (entry.candidate.awareness as Readonly<Record<string, unknown>>).origin;
    if (typeof origin !== 'object' || origin === null) return null;
    const runId: unknown = (origin as Readonly<Record<string, unknown>>).runId;
    return typeof runId === 'string' && runId.trim() ? runId.trim() : null;
}

/**
 * A worker whose machine went offline with its turn in flight (ORC O7). The Session facts owner's
 * stalled fact, which the Work tab counts too; outstanding reports never make a worker stalled.
 */
function isStalledWorker(session: Session, nowMs: number): boolean {
    if (!readSessionManagerSessionIdV1(session) || typeof session.archivedAt === 'number') return false;
    return readSessionWorkStalled(session, nowMs);
}

const EMPTY_SESSIONS: readonly Session[] = Object.freeze([]);
const EMPTY_STANDINGS: Readonly<Record<string, SessionAttentionStanding>> = Object.freeze({});
function useCreateInboxWorkProjection() {
    const { source, overview } = useActivityOverview();
    // Grouping lists every open request: the full Inbox census while this projection is mounted.
    useInboxArtifactRowDemand();
    const openApprovalEntries = storage(state => state.artifactListedOpenApprovals);
    const artifactSource = useInboxArtifactSource();
    const profileScope = storage(state => state.profileScope);
    const pluginSessionInbox = useInboxPluginSessionRows();
    const executionRuns = useInboxExecutionRunSource();
    const workflowAttention = useFullWorkflowAttentionSource();
    const workflowRunOnceDeliveries = React.useMemo(() => new Map(executionRuns.workflowFollows.map(follow =>
        [follow.source.runId, follow.onceDeliveries ?? []] as const)), [executionRuns.workflowFollows]);
    const workflowRunIds = React.useMemo(() => [...new Set([...workflowAttention.runIds, ...workflowRunOnceDeliveries.keys()])],
        [workflowAttention.runIds, workflowRunOnceDeliveries]);
    const loadedWorkflowRuns = useWorkflowRunRows(workflowRunIds);
    const workflowRuns = React.useMemo(() => loadedWorkflowRuns.filter(row => workflowAttention.runIds.includes(row.id)
        || workflowRunOnceDeliveries.get(row.id)?.some(delivery => delivery.event.kind !== 'needs_you')
        || row.summary?.attentionRequired === true && workflowRunOnceDeliveries.has(row.id)),
    [loadedWorkflowRuns, workflowAttention.runIds, workflowRunOnceDeliveries]);
    const automationAttention = useAutomationAttentionSource();
    const automationRuns = useWorkflowRunRows(automationAttention.runIds);
    const attentionStandings = storage((state) => state.sessionOrganizationAttentionStandingsBySessionKey) ?? EMPTY_STANDINGS;
    const appearanceHomes = React.useMemo(() => [...new Set(overview.candidates.flatMap(candidate => {
        const home = candidate.address?.serverId ?? candidate.serverId;
        return home ? [home] : [];
    }))], [overview.candidates]);
    const appearanceOrganizations = useSessionOrganizationProjections(appearanceHomes);
    const selectAppearanceTargets = React.useMemo(() => {
        let previousMachines: Parameters<typeof projectSessionWorkspaceColors>[0]['machines'];
        let previousTargets: readonly Readonly<{ serverId: string; sessionId: string; workspaceKey: string | null; workspaceColor: SessionAppearanceColor | null | undefined }>[] | undefined;
        return (machines: Parameters<typeof projectSessionWorkspaceColors>[0]['machines']) => {
            if (previousTargets && machines === previousMachines) return previousTargets;
            const workspaceColorsByServerId = new Map(appearanceHomes.map(serverId => {
                const view = buildSessionOrganizationListViewState({ serverId, projection: appearanceOrganizations[serverId] ?? null });
                return [serverId, projectSessionWorkspaceColors({ workspaceColors: view.workspaceColorsV1,
                    workspaceRefs: source.workspaceRefsV1 ?? [], censusServerId: serverId === source.activeServerId ? serverId : undefined, machines })] as const;
            }));
            const indexed = new Map(Object.entries(source.sessionListIndexByServerId).flatMap(([serverId, items]) =>
                (items ?? []).flatMap(item => item.type === 'session' ? [[sessionAddressKey({ serverId, sessionId: item.sessionId }), item] as const] : [])));
            const targets = overview.candidates.flatMap(candidate => {
                const serverId = candidate.address?.serverId ?? candidate.serverId;
                if (!serverId) return [];
                const item = indexed.get(sessionAddressKey({ serverId, sessionId: candidate.sessionId }));
                const workspaceKey = readSessionAppearanceWorkspaceKey(item ?? (candidate.session.projectKey ? {
                    projectKey: { serverId, projectKey: candidate.session.projectKey },
                } : {}));
                return [{ serverId, sessionId: candidate.sessionId, workspaceKey,
                    workspaceColor: workspaceKey ? workspaceColorsByServerId.get(serverId)?.[workspaceKey] : null }];
            });
            previousMachines = machines;
            previousTargets = targets;
            return targets;
        };
    }, [appearanceHomes, appearanceOrganizations, overview.candidates, source.sessionListIndexByServerId, source.workspaceRefsV1, source.activeServerId]);
    const appearanceTargets = useMachineDisplayById(selectAppearanceTargets);
    const selectAppearanceColors = React.useMemo(() => createEffectiveSessionAppearanceColorsSelector(appearanceTargets), [appearanceTargets]);
    const appearanceColorsBySessionKey = storage(selectAppearanceColors);
    const sessionPresentation = React.useMemo(
        () => buildInboxSessionPresentation({
            appearanceColorsBySessionKey,
            overview,
            resolveMessages: (candidate) => readActivitySourceAttentionMessages(source, candidate.address),
        }),
        [overview, source.sessionMessagesById, source.sessionsById, appearanceColorsBySessionKey],
    );

    const sessionsById = source.sessionsById;
    const resolveInboxSession = React.useCallback((sessionId: string, serverId?: string | null) => {
        const home = serverId ?? profileScope?.serverId;
        const row = readSessionListRowForServerId(source.sessionListRowsByServerId, home, sessionId);
        if (row) return row;
        const hydrated = sessionsById[sessionId];
        return hydrated && areServerProfileIdentifiersEquivalent(hydrated.serverId, home) ? hydrated : null;
    }, [source.sessionListRowsByServerId, profileScope?.serverId, sessionsById]);
    const landings = React.useMemo(() => pluginSessionInbox.rows.flatMap(({ row }) => {
        if (row.landing?.state !== 'open') return [];
        const standing = attentionStandings[buildSessionOrganizationSessionKey(row.session.serverId, row.session.sessionId)];
        if (standing?.standing === false) return [];
        const session = resolveInboxSession(row.session.sessionId, row.session.serverId);
        if (!session?.serverId || !areServerProfileIdentifiersEquivalent(session.serverId, row.session.serverId)
            || typeof session.archivedAt === 'number') return [];
        return [{ session, link: row.landing }];
    }), [pluginSessionInbox.rows, attentionStandings, resolveInboxSession]);
    const stalledSessions = React.useMemo(() => {
        const nowMs = Date.now();
        const stalled = Object.values(sessionsById).filter((session) => isStalledWorker(session, nowMs));
        return stalled.length === 0 ? EMPTY_SESSIONS : stalled;
    }, [sessionsById]);
    const snoozed = React.useMemo(() => {
        const nowMs = Date.now();
        return Object.values(sessionsById).flatMap((session) => {
            const standing = attentionStandings[buildSessionOrganizationSessionKey(session.serverId ?? '', session.id)];
            return typeof standing?.remindAt === 'number' && standing.remindAt > nowMs
                ? [{ session, remindAt: standing.remindAt }]
                : [];
        });
    }, [attentionStandings, sessionsById]);
    const previousWorkGroups = React.useRef<readonly InboxWorkGroup[]>([]);
    const workGroups = React.useMemo(() => {
        const next = buildInboxWorkGroups({
        sessionEntries: sessionPresentation.sessionsNeedingAttention,
        workflowRuns,
        workflowServerId: workflowAttention.serverId,
        automationRuns,
        automationServerId: automationAttention.serverId,
        openApprovals: Object.values(openApprovalEntries),
        stalledSessions,
        landings,
        snoozed,
        resolveSession: resolveInboxSession,
        resolveOriginRunId: readAwarenessOriginRunId,
        }, previousWorkGroups.current);
        previousWorkGroups.current = next;
        return next;
    }, [automationAttention.serverId, automationRuns, openApprovalEntries, sessionPresentation.sessionsNeedingAttention, resolveInboxSession, landings, snoozed, stalledSessions, workflowRuns, workflowAttention.serverId]);

    const membershipLoading = artifactSource.phase === 'loading' || executionRuns.loading
        || (!source.isDataReady && overview.candidates.length === 0)
        || (workflowAttention.available && workflowAttention.phase === 'loading')
        || (automationAttention.available && automationAttention.phase === 'loading') || pluginSessionInbox.loading;
    const previousMembership = React.useRef<InboxWorkMembership | null>(null);
    const membership = React.useMemo(() => {
        const refs: InboxWorkMembership['refs'][number][] = [];
        for (const group of workGroups) for (const item of group.items) {
            if (item.kind === 'session' && item.entry.candidate.address) refs.push({ kind: 'session', address: item.entry.candidate.address });
            else if (item.kind === 'workflow_run') refs.push({ kind: 'workflow_run', runId: item.runId });
        }
        const previous = previousMembership.current;
        const retained = refs.map((ref, index) => {
            const old = previous?.refs[index];
            return old && (ref.kind === 'session' && old.kind === 'session'
                ? sessionAddressKey(ref.address) === sessionAddressKey(old.address)
                : ref.kind === 'workflow_run' && old.kind === 'workflow_run' && ref.runId === old.runId) ? old : ref;
        });
        const stableRefs = previous && retained.length === previous.refs.length
            && retained.every((ref, index) => ref === previous.refs[index]) ? previous.refs : retained;
        const next = previous && stableRefs === previous.refs && membershipLoading === previous.isLoading
            ? previous : { refs: stableRefs, isLoading: membershipLoading };
        previousMembership.current = next;
        return next;
    }, [workGroups, membershipLoading]);
    return React.useMemo(() => ({ source, overview, openApprovalEntries, artifactSource, profileScope,
        pluginSessionInbox, executionRuns, workflowAttention, workflowRunOnceDeliveries, automationAttention,
        automationRuns, attentionStandings, sessionsById, sessionPresentation, workGroups, membership }),
    [source, overview, openApprovalEntries, artifactSource, profileScope, pluginSessionInbox, executionRuns,
        workflowAttention, workflowRunOnceDeliveries, automationAttention, automationRuns, attentionStandings,
        sessionsById, sessionPresentation, workGroups, membership]);
}

export type InboxWorkMembership = Readonly<{
    refs: readonly (Readonly<{ kind: 'session'; address: SessionAddress }> | Readonly<{ kind: 'workflow_run'; runId: string }>)[];
    isLoading: boolean;
}>;
type InboxWorkProjection = ReturnType<typeof useCreateInboxWorkProjection>;
type ProjectionStore = StoreApi<InboxWorkProjection | null>;
const ProjectionContext = React.createContext<ProjectionStore | null>(null);

/** The same grouping producer serves membership readers and the full Inbox; detail rows are demand-local. */
export function InboxWorkProjectionBoundary(props: Readonly<{ children: React.ReactNode; enabled?: boolean }>) {
    const existing = React.useContext(ProjectionContext);
    const [store] = React.useState(() => createStore<InboxWorkProjection | null>(() => null));
    return <ProjectionContext.Provider value={existing ?? store}>
        {(props.enabled ?? true) && !existing ? <InboxArtifactSourceBoundary><WorkflowAttentionSourceBoundary>
            <InboxExecutionRunSourceBoundary><ProjectionPublisher store={store} /></InboxExecutionRunSourceBoundary>
        </WorkflowAttentionSourceBoundary></InboxArtifactSourceBoundary> : null}
        {props.children}
    </ProjectionContext.Provider>;
}

function ProjectionPublisher({ store }: Readonly<{ store: ProjectionStore }>) {
    // Grouping reads header list facts; each mounted approval row reads its own body (ApprovalInboxCard).
    const projection = useCreateInboxWorkProjection();
    React.useLayoutEffect(() => { store.setState(projection, true); }, [store, projection]);
    React.useLayoutEffect(() => () => { store.setState(null, true); }, [store]);
    return null;
}

const selectProjection = (projection: InboxWorkProjection | null) => projection;
const selectMembership = (projection: InboxWorkProjection | null) => projection?.membership ?? null;
const subscribeNothing = () => () => {};
const readNothing = () => null;

export function useInboxWorkProjection() {
    const store = React.useContext(ProjectionContext);
    if (!store) throw new Error('useInboxWorkProjection requires InboxWorkProjectionBoundary');
    return useStore(store, selectProjection);
}

/** Key-scoped work membership: unrelated row, friend or notice presentation never wakes this reader. */
export function useInboxWorkMembershipWhen(enabled: boolean): InboxWorkMembership | null {
    const store = enabled ? React.use(ProjectionContext) : null;
    const read = React.useCallback(() => store ? selectMembership(store.getState()) : null, [store]);
    return React.useSyncExternalStore(store?.subscribe ?? subscribeNothing, store ? read : readNothing, readNothing);
}
