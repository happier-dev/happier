import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import type { Prisma } from '@prisma/client';
import { isProjectedSessionStalledV1, projectSessionAwarenessRuntimeV1, resolveSessionAwarenessLifecycleV1 } from '@happier-dev/protocol/sessions/awareness/runtime';
import { parseSessionRuntimeActivityProjectionFields, SessionRuntimeScheduledWakeSchema } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { isSessionAwarenessTurnFinishedV1, projectSessionAwarenessOperationalV1 } from '@happier-dev/protocol/sessions/awareness/projectV1';
import { readSessionAwarenessWorkStatusV1, readSessionAwarenessPresentationRankV1, type SessionAwarenessPresentationStateV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { type SessionManagedSessionsV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { resolveFollowDeliveryV1, resolveInboxItemAttentionV1, resolveSessionInboxAttentionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { isFollowDeliveryMutedV1, readPersistedFollowDeliveryMutesV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { type V2SessionRecord } from '@happier-dev/protocol/sessions/control/contract';
import type { Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import {
    buildSessionAccessWhere,
    resolveEffectiveSessionAccessWhere,
    type SessionCollectiveAccessSnapshot,
} from '@/app/session/access/sessionAccessWhere';
import {
    hasSessionTranscriptPublicationLiveFacts,
    isSessionTranscriptShareable,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from '@/app/session/sessionTranscriptPublicationPolicy';
import { parseStoredSessionLatestTurnStatus, readLatestTurnStatusObservedAt } from '@/app/session/listing/rows';
import { AUTOMATION_RUN_TERMINAL_STATES } from '@/app/automations/automationTypes';
import { readAccountFollowRuleReceiverCountsInTx } from '@/app/session/follow/accountFollowRuleService';
import { hasSessionFollowSessionSource } from '@/app/session/follow/sessionFollowSourceIdentity';
import { createSessionPersonalAttentionProjectionSelect, loadSessionLatestFailureSequencesInTx, projectSessionViewerAttention } from '@/app/session/personal/projection';
import { QUIET_SESSION_PERSONAL_DISCUSSION_FACTS } from '@/app/session/personal/discussionFacts';
import { readStoredPolicy } from '@/app/session/follow/storedSessionFollowPolicy';

/** Content-free turn-end review barrier; FIN owns the run lifecycle and terminal vocabulary. */
export async function readSessionPendingReviewRunCountsInTx(tx: Tx, sessionIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (sessionIds.length === 0) return new Map();
    const runs = await tx.automationRun.groupBy({
        by: ['causeSourceSessionId'],
        where: { causeSourceSessionId: { in: [...sessionIds] }, causeTriggerKind: 'sessionLifecycle',
            causeSessionLifecycleEvent: { in: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'] },
            state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] } },
        _count: { _all: true },
    });
    return new Map(runs.flatMap((run) => run.causeSourceSessionId ? [[run.causeSourceSessionId, run._count._all] as const] : []));
}

const REPORT_SESSION_SELECT = {
    id: true,
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    archivedAt: true,
    latestTurnId: true,
    latestTurnStatus: true,
    latestTurnStatusObservedAt: true,
    latestReadyEventSeq: true,
    latestReadyEventAt: true,
    meaningfulActivityAt: true,
    active: true,
    lastActiveAt: true,
    thinking: true,
    thinkingAt: true,
    runtimeActivityState: true,
    runtimeActivityActiveCount: true,
    runtimeActivityScheduledWake: true,
    runtimeActivityObservedAt: true,
    runtimeActivityRevision: true,
    pendingPermissionRequestCount: true,
    pendingSharedActionConfirmationCount: true,
    pendingUserActionRequestCount: true,
    pendingRequestObservedAt: true,
    pendingCount: true,
    pendingBlockedCount: true,
} as const satisfies Prisma.SessionSelect;

function createReportSessionSelect(accountId: string) {
    return { ...REPORT_SESSION_SELECT, ...createSessionPersonalAttentionProjectionSelect(accountId) } as const satisfies Prisma.SessionSelect;
}

type ReportSessionRow = Prisma.SessionGetPayload<{ select: ReturnType<typeof createReportSessionSelect> }>;

type ReportOperationalRow = Prisma.SessionGetPayload<{ select: typeof REPORT_SESSION_SELECT }>;

export const SESSION_FINISHED_TURN_SELECT = { ...REPORT_SESSION_SELECT, deliveryMutes: true } as const;
type FinishedTurnRow = Prisma.SessionGetPayload<{ select: typeof SESSION_FINISHED_TURN_SELECT }>;

function projectReportOperational(row: ReportOperationalRow, nowMs: number, managedWorkingCount = 0) {
    const liveFacts = hasSessionTranscriptPublicationLiveFacts(row);
    const lifecycle = {
        archivedAtMs: row.archivedAt?.getTime() ?? null,
        latestTurnStatus: liveFacts ? parseStoredSessionLatestTurnStatus(row.latestTurnStatus) : null,
        latestTurnStatusObservedAtMs: liveFacts ? readLatestTurnStatusObservedAt(row.latestTurnStatusObservedAt) : null,
        latestReadyEventSeq: liveFacts ? row.latestReadyEventSeq : null,
        latestReadyEventAtMs: liveFacts ? row.latestReadyEventAt?.getTime() ?? null : null,
        meaningfulActivityAtMs: row.meaningfulActivityAt?.getTime() ?? null,
    };
    const parsedActivity = liveFacts ? parseSessionRuntimeActivityProjectionFields({
        runtimeActivityState: row.runtimeActivityState,
        runtimeActivityActiveCount: row.runtimeActivityActiveCount,
        ...(row.runtimeActivityScheduledWake != null ? { runtimeActivityScheduledWake: row.runtimeActivityScheduledWake } : {}),
        runtimeActivityObservedAt: readLatestTurnStatusObservedAt(row.runtimeActivityObservedAt),
        runtimeActivityRevision: readLatestTurnStatusObservedAt(row.runtimeActivityRevision),
    }) : null;
    const activity = parsedActivity?.kind === 'valid' ? parsedActivity.projection : null;
    const runtime = projectSessionAwarenessRuntimeV1({
        nowMs,
        lifecycle,
        managedWorkingCount,
        runtime: {
            presence: 'unknown',
            active: liveFacts && row.active,
            lastObservedAtMs: liveFacts ? row.lastActiveAt.getTime() : null,
            thinking: liveFacts && row.thinking,
            thinkingAtMs: liveFacts ? row.thinkingAt?.getTime() ?? null : null,
            activityState: activity?.state ?? null,
            activityActiveCount: activity?.activeCount ?? null,
            scheduledWake: activity?.scheduledWake,
        },
        pending: liveFacts ? {
            hasPendingPermissionRequests: row.pendingPermissionRequestCount + row.pendingSharedActionConfirmationCount > 0,
            hasPendingUserActionRequests: row.pendingUserActionRequestCount > 0,
            pendingRequestObservedAtMs: row.pendingRequestObservedAt?.getTime() ?? null,
            queuedInputCount: row.pendingCount,
            blockedInputCount: row.pendingBlockedCount,
        } : {},
    });
    const operational = projectSessionAwarenessOperationalV1({ runtime, lifecycle });
    const stalled = liveFacts && !runtime.archived
        && isProjectedSessionStalledV1({ active: row.active, latestTurnStatus: lifecycle.latestTurnStatus });
    return { lifecycle, runtime, operational, liveFacts, stalled };
}

function projectReportWorkStatus(row: ReportSessionRow, input: Readonly<{
    accountId: string; nowMs: number; latestFailureSeq: number | null; qualifiedTeamIds?: ReadonlySet<string>;
}>) {
    const { lifecycle, runtime, operational, liveFacts, stalled } = projectReportOperational(row, input.nowMs);
    const attention = projectSessionViewerAttention({ row, latestFailureSeq: input.latestFailureSeq,
        viewerAccountId: input.accountId, discussion: QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
        qualifiedTeamIds: input.qualifiedTeamIds, now: input.nowMs });
    const finished = isSessionAwarenessTurnFinishedV1(lifecycle.latestTurnStatus, operational);
    const status = readSessionAwarenessWorkStatusV1({ awareness: {
        runtime: runtime.runtime,
        freshness: runtime.freshness,
        lifecycle: resolveSessionAwarenessLifecycleV1(lifecycle, false, runtime.scheduledWakeOutcome),
        operational,
        scheduledWakeOutcome: runtime.scheduledWakeOutcome,
        viewer: { attention },
    } });
    const inboxAttention = resolveSessionInboxAttentionV1({ personalAttention: attention,
        hasBlockedPendingDelivery: liveFacts && row.pendingBlockedCount > 0,
        working: status.bucket === 'working', ready: finished });
    return {
        // Public runtime/lifecycle facts share Work's Protocol precedence. Content availability
        // remains a client verdict; no encryption/readability assertion is made by this count.
        status,
        finished,
        needsYou: inboxAttention.section !== null && inboxAttention.type !== null && resolveInboxItemAttentionV1(inboxAttention.type).interrupt,
        // The existing presence publisher/timeout owns Session.active; only its own turn can stall it.
        stalled,
    };
}

/**
 * This is a source-side decision. A managed report can hold its manager's work
 * independently of any particular notification recipient's transcript access.
 */
export async function readSessionFinishedTurnInTx(
    tx: Tx,
    session: FinishedTurnRow,
    nowMs: number,
    options?: Readonly<{ recoverFromSnapshot: true }>,
) {
    const recovering = options?.recoverFromSnapshot === true;
    const turnId = session.latestTurnId;
    // A read can show an expired wake as idle without authorizing delivery.
    if (!turnId || (recovering && (!session.active || session.runtimeActivityScheduledWake !== null))) return null;
    const primary = projectReportOperational(session, nowMs);
    if (!isSessionAwarenessTurnFinishedV1(primary.lifecycle.latestTurnStatus, primary.operational)) return null;

    const workers = await tx.sessionFollowEdge.findMany({
        where: { relation: 'manager', destinationSessionId: session.id },
        select: { sourceSession: { select: { ...REPORT_SESSION_SELECT, originKind: true } },
            deliveredTurnId: true, deliveredTurnStatus: true, policyJson: true },
    });
    const awaitingReports: string[] = [];
    const managedWorkingCount = workers.filter(edge => {
        const worker = edge.sourceSession;
        if (!worker) return false;
        if (recovering && worker.active && worker.runtimeActivityScheduledWake !== null
            && !SessionRuntimeScheduledWakeSchema.safeParse(worker.runtimeActivityScheduledWake).data?.outcome) return true;
        const projected = projectReportOperational(worker, nowMs);
        if (!projected.stalled && (projected.runtime.working || projected.runtime.backgroundActive)) return true;
        if (session.active && worker.originKind === 'session'
            && isSessionAwarenessTurnFinishedV1(projected.lifecycle.latestTurnStatus, projected.operational)
            && (edge.deliveredTurnId !== worker.latestTurnId || edge.deliveredTurnStatus !== 'completed')) {
            const policy = readStoredPolicy(edge.policyJson);
            if (policy && resolveFollowDeliveryV1({ policies: [policy], ownWorker: true, event: { kind: 'finished' } }).session.wake) {
                awaitingReports.push(worker.id);
            }
        }
        return false;
    }).length;
    // A delegated report already selected to wake the lead belongs to its
    // outstanding work until the existing Follow frontier accepts that Turn.
    if (awaitingReports.length > 0) {
        const scopes = readPersistedFollowDeliveryMutesV1(session.deliveryMutes);
        if (scopes && awaitingReports.some(id => !isFollowDeliveryMutedV1(scopes, {
            senderSessionId: id, source: { kind: 'session', sessionId: id },
        }))) return null;
    }
    const { lifecycle, operational } = projectReportOperational(session, nowMs, managedWorkingCount);
    return isSessionAwarenessTurnFinishedV1(lifecycle.latestTurnStatus, operational) ? turnId : null;
}

type SessionManagerContribution = Readonly<{
    sessionId: string; managerSessionId: string; working: boolean; needsYou: boolean; stalled: boolean; archived: boolean;
    finished: boolean; attentionPrimary: SessionAwarenessPresentationStateV1;
}>;

type SessionManagerProjectionRow = {
    id: string; ownerAccountId?: string; accountId?: string;
    manager?: V2SessionRecord['manager']; managedSessions?: V2SessionRecord['managedSessions'];
    receivedRuleCount?: number;
};

function projectCapturedReports<T extends SessionManagerProjectionRow>(sessions: readonly T[], contributions: readonly SessionManagerContribution[]): (T & SessionManagerProjectionRow)[] {
    const leads = new Map<string, string>();
    const reports = new Map<string, Required<SessionManagedSessionsV1>>();
    for (const contribution of contributions) {
        leads.set(contribution.sessionId, contribution.managerSessionId);
        const counts = reports.get(contribution.managerSessionId) ?? { total: 0, working: 0, needsYou: 0, stalled: 0, archived: 0, finished: 0, attentionPrimary: null };
        counts.total += 1;
        if (contribution.archived) counts.archived += 1;
        else {
            if (contribution.working) counts.working += 1;
            if (contribution.needsYou) counts.needsYou += 1;
            if (contribution.stalled) counts.stalled += 1;
            if (contribution.finished) counts.finished += 1;
            if (counts.attentionPrimary === null || readSessionAwarenessPresentationRankV1(contribution.attentionPrimary)
                > readSessionAwarenessPresentationRankV1(counts.attentionPrimary)) counts.attentionPrimary = contribution.attentionPrimary;
        }
        reports.set(contribution.managerSessionId, counts);
    }
    return sessions.map(session => {
        const projected: T = { ...session };
        delete projected.manager;
        const lead = leads.get(session.id);
        if (lead) projected.manager = { sessionId: lead };
        projected.managedSessions = reports.get(session.id) ?? { total: 0, working: 0, needsYou: 0, stalled: 0, archived: 0, finished: 0, attentionPrimary: null };
        return projected;
    });
}

/** One batch acquires authorized relation facts for every returned list/detail row. */
export async function projectSessionManagerForRowsInTx<T extends SessionManagerProjectionRow>(tx: Tx, input: Readonly<{
    accountId: string;
    authentication: SessionAccessAuthentication;
    sessions: readonly T[];
    accessMode: 'legacy_owner_or_direct' | 'effective_access_v1';
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
    nowMs: number;
    /** One containing listing snapshot may reuse its already admitted private membership read. */
    ruleReceiverCounts?: ReadonlyMap<string, number> | null;
}>) {
    if (input.sessions.length === 0) return [];
    const sessionIds = input.sessions.map((session) => session.id);
    const ruleCounts = input.ruleReceiverCounts === undefined
        ? await readAccountFollowRuleReceiverCountsInTx(tx, input) : input.ruleReceiverCounts;
    const pendingReviewRuns = await readSessionPendingReviewRunCountsInTx(tx, sessionIds);
    const edges = await tx.sessionFollowEdge.findMany({
        where: { relation: 'manager', OR: [{ sourceSessionId: { in: sessionIds } }, { destinationSessionId: { in: sessionIds } }] },
        select: { sourceSessionId: true, destinationSessionId: true },
    });
    const sessionEdges = edges.filter(hasSessionFollowSessionSource);
    const relatedIds = [...new Set(sessionEdges.flatMap((edge) => [edge.sourceSessionId, edge.destinationSessionId]))];
    let related: ReportSessionRow[] = [];
    if (relatedIds.length > 0) {
        const accessWhere = input.accessMode === 'legacy_owner_or_direct' && !input.authentication.sessionRuntimePrincipal
            ? buildSessionAccessWhere({ accountId: input.accountId, capability: 'readTranscript', mode: 'legacy_owner_or_direct' })
            : (await resolveEffectiveSessionAccessWhere({
                tx, accountId: input.accountId, capability: 'readTranscript', mode: 'effective_access_v1',
                authentication: input.authentication, collectiveAccessSnapshot: input.collectiveAccessSnapshot,
            })).where;
        related = await tx.session.findMany({
            where: { AND: [accessWhere, { id: { in: relatedIds } }] },
            select: withSessionContentSelect(createReportSessionSelect(input.accountId)),
        }).then(decodeSessionStoredContent);
    }
    const readable = new Map(related.filter((row) => row.accountId === input.accountId || isSessionTranscriptShareable(row))
        .map((row) => [row.id, row]));
    // Neither an unreadable parent nor an unreadable child leaks via counts or IDs.
    const admittedEdges = sessionEdges.filter(edge => readable.has(edge.sourceSessionId) && readable.has(edge.destinationSessionId));
    const latestFailureSequences = await loadSessionLatestFailureSequencesInTx(tx,
        admittedEdges.map(edge => readable.get(edge.sourceSessionId)!));
    const contributions: SessionManagerContribution[] = [];
    for (const edge of admittedEdges) {
        const child = readable.get(edge.sourceSessionId)!;
        const { status, stalled, finished, needsYou } = projectReportWorkStatus(child, {
            accountId: input.accountId, nowMs: input.nowMs, latestFailureSeq: latestFailureSequences.get(child.id) ?? null,
            qualifiedTeamIds: input.collectiveAccessSnapshot?.qualifiedTeamIds,
        });
        contributions.push({ sessionId: edge.sourceSessionId, managerSessionId: edge.destinationSessionId, working: status.bucket === 'working' && !stalled,
            needsYou, stalled, finished, attentionPrimary: status.state, archived: child.archivedAt != null });
    }
    return projectCapturedReports(input.sessions.map(session => {
        const projected = { ...session, pendingReviewRuns: pendingReviewRuns.get(session.id) ?? 0 };
        delete projected.receivedRuleCount;
        const own = (session.ownerAccountId ?? session.accountId) === input.accountId;
        if (own && ruleCounts) projected.receivedRuleCount = ruleCounts.get(session.id) ?? 0;
        return projected;
    }), contributions);
}
