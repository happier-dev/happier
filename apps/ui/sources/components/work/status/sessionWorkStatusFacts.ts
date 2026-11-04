import type { SessionManagedSessionsV1 } from '@happier-dev/protocol';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { SessionPersonalAttentionProjectionV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { resolvePendingRequestAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { resolveSessionInboxAttentionV1, resolveRequestFollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { resolvePersonalFollowOnceAttentionV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { selectOldestPendingRequest } from '@happier-dev/session-core/pending';

import { hasProjectedActiveTurn } from '@/sync/domains/session/attention/runtimePresentation';
import { getSessionStatus, type SessionStatus } from '@/utils/sessions/sessionUtils';
import { resolveSessionPersonalAttentionForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { listPendingSessionRequests } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { listSessionListPresentationPendingRequests, type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { t } from '@/text';

import type { WorkStatusInput } from './resolveWorkStatusTone';
import { createCollectionSessionRequestIdentity } from '@/components/ui/lists/collection/collectionRequestRef';

export type SessionWorkStatusFacts = Extract<WorkStatusInput, { kind: 'session' }>['facts'];

type SessionReportCounts = Readonly<{ managedSessions?: SessionManagedSessionsV1 | null }>;

/** The reports the server counts as still going for this Session: working, waiting on a person, or stalled. */
function countOutstandingReports(session: SessionReportCounts): number {
    const reports = session.managedSessions;
    return reports ? reports.working + reports.needsYou + reports.stalled : 0;
}

/**
 * A lead is never finished while work it delegated is still going (ORC R-10). Whoever counts the
 * reports — the server's awareness count on the Session, or the Work projection over the subtree it
 * holds — passes the count here; this is the one place it changes "settled". It never touches what
 * the stalled check reads (`sessionWorkStalledFromStatus`).
 */
export function withOutstandingReports(facts: SessionWorkStatusFacts, outstandingReports: number): SessionWorkStatusFacts {
    return facts.settled && outstandingReports > 0 ? { ...facts, settled: false } : facts;
}

/**
 * The Session owner's facts for `resolveWorkStatusTone`'s session arm, from a live Session or a
 * Home-qualified list row: its awareness, its own state word, and whether the Session itself says its
 * work is settled with none of its reports still going. Boards cards, the Inbox, Sessions list rows
 * and the Work tab's report rows all read them here.
 */
export function readSessionWorkStatusFacts(
    session: Parameters<typeof getSessionStatus>[0] & SessionReportCounts,
    nowMs: number,
    presentationSource?: SessionListPresentationSource,
): SessionWorkStatusFacts {
    // These rows carry their own time, so a detached Session's word never says when it was last seen;
    // the shared presenter still owns whether explicit process-terminal evidence says Stopped.
    const status = getSessionStatus(session, nowMs, {
        workingTextMode: 'static', includeTitle: false, disconnectedTextMode: 'offline', presentationSource,
    });
    return sessionWorkStatusFactsFromStatus(session, status, { nowMs, presentationSource });
}

/**
 * The same facts from a status the caller already projected (a Sessions list row projects it once,
 * with its own working-word mode), so "settled" has one rule whichever surface asks.
 */
export function sessionWorkStatusFactsFromStatus(
    session: Parameters<typeof getSessionStatus>[0] & SessionReportCounts,
    status: Pick<SessionStatus, 'awareness' | 'statusText' | 'state'>,
    options: Readonly<{ nowMs?: number; personalAttention?: SessionPersonalAttentionProjectionV1; presentationSource?: SessionListPresentationSource }> = {},
): SessionWorkStatusFacts {
    const personal = options.personalAttention
        ?? resolveSessionPersonalAttentionForViewer(session, options.nowMs ?? Date.now(), [], undefined, options.presentationSource);
    const viewer = personal === session.viewer?.attention ? session.viewer : { attention: personal };
    const requestReason = personal.reasons.includes('permission_required') ? 'permission_required'
        : personal.reasons.includes('user_action_required') ? 'user_action_required' : null;
    // The already-held request owner supplies type/handler/mode; rows never hydrate a body here.
    const request = requestReason && (options.presentationSource || 'agentState' in session) ? selectOldestPendingRequest(
        (options.presentationSource ? listSessionListPresentationPendingRequests(options.presentationSource, [])
            : 'agentState' in session ? listPendingSessionRequests(session, []) : []).filter(value => resolvePendingRequestAttentionReasonV1(value) === requestReason),
    ) : undefined;
    const requestFollowEvent = request ? resolveRequestFollowEventV1({
        requestKind: requestReason === 'permission_required' ? 'permission' : 'user_action',
        questionV1: request.questionV1, currentHandler: request.currentHandler,
    }) : undefined;
    const onceDelivery = session.viewer?.follow.onceDelivery;
    const attention = resolveSessionInboxAttentionV1({
        personalAttention: personal,
        hasBlockedPendingDelivery: personal.reasons.includes('pending_blocked'),
        working: status.awareness.operational.reasons.includes('working')
            || status.awareness.operational.reasons.includes('background_activity'),
        ready: status.state === 'ready' || status.state === 'finished_unseen'
            || status.awareness.operational.reasons.includes('ready'),
        questionType: request?.questionV1?.type,
        onceDelivery, onceAttentionReason: resolvePersonalFollowOnceAttentionV1({ delivery: onceDelivery }),
    });
    return withOutstandingReports({
        awareness: status.awareness,
        viewer,
        attentionType: attention.type,
        ...(request ? { currentRequest: request } : {}),
        currentRequestRef: request ? createCollectionSessionRequestIdentity(request)
            : requestReason && 'currentRequestRef' in session ? session.currentRequestRef ?? null : null,
        ...(requestFollowEvent ? { requestFollowEvent } : {}),
        archiving: status.state === 'archiving',
        word: status.state === 'archiving' ? status.statusText
            : readSessionAwarenessPresentationV1({ ...status.awareness, viewer }) === 'unknown' ? t('status.unknownState') : status.statusText,
        // Settled is the Session's own statement — its latest turn completed and it reads Ready — not
        // merely "no turn in flight": a quiet Session with nothing to show is idle, not finished.
        settled: status.awareness.operational.primary === 'ready',
    }, countOutstandingReports(options.presentationSource ? options.presentationSource.relations : session));
}

type TurnFacts = Readonly<{ latestTurnStatus?: Parameters<typeof hasProjectedActiveTurn>[0] }>;

type SessionStalledAwareness = Readonly<{ awareness: Pick<SessionStatus['awareness'], 'runtime'> & Readonly<{
    operational: Pick<SessionStatus['awareness']['operational'], 'primary'>;
}> }>;

function isTurnInFlight(session: TurnFacts, status: SessionStalledAwareness): boolean {
    return hasProjectedActiveTurn(session.latestTurnStatus) || status.awareness.operational.primary === 'working';
}

/**
 * Stalled (ORC O7, §3.5): the Session's presence is offline while one of its own turns is in flight.
 * Its reports never make it stalled — `withOutstandingReports` only keeps it from being settled — so an
 * offline lead waiting on working reports reads as offline and unfinished, not stalled.
 */
export function sessionWorkStalledFromStatus(session: TurnFacts, status: SessionStalledAwareness): boolean {
    return status.awareness.runtime === 'offline' && isTurnInFlight(session, status);
}

export function readSessionWorkStalled(session: Parameters<typeof getSessionStatus>[0], nowMs: number,
    source?: SessionListPresentationSource): boolean {
    return sessionWorkStalledFromStatus(source?.lifecycle ?? session, getSessionStatus(session, nowMs, { presentationSource: source }));
}
