import type { SessionReportsV1 } from '@happier-dev/protocol';

import { hasProjectedActiveTurn } from '@/sync/domains/session/attention/runtimePresentation';
import { getSessionStatus, type SessionStatus } from '@/utils/sessions/sessionUtils';

import type { WorkStatusInput } from './resolveWorkStatusTone';

export type SessionWorkStatusFacts = Extract<WorkStatusInput, { kind: 'session' }>['facts'];

type SessionReportCounts = Readonly<{ reports?: SessionReportsV1 | null }>;

/** The reports the server counts as still going for this Session: working, waiting on a person, or stalled. */
function countOutstandingReports(session: SessionReportCounts): number {
    const reports = session.reports;
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
): SessionWorkStatusFacts {
    return sessionWorkStatusFactsFromStatus(session, getSessionStatus(session, nowMs, { workingTextMode: 'static', includeTitle: false }));
}

/**
 * The same facts from a status the caller already projected (a Sessions list row projects it once,
 * with its own working-word mode), so "settled" has one rule whichever surface asks.
 */
export function sessionWorkStatusFactsFromStatus(
    session: SessionReportCounts,
    status: Pick<SessionStatus, 'awareness' | 'statusText'>,
): SessionWorkStatusFacts {
    return withOutstandingReports({
        awareness: status.awareness,
        word: status.statusText,
        // Settled is the Session's own statement — its latest turn completed and it reads Ready — not
        // merely "no turn in flight": a quiet Session with nothing to show is idle, not finished.
        settled: status.awareness.operational.primary === 'ready',
    }, countOutstandingReports(session));
}

type TurnFacts = Readonly<{ latestTurnStatus?: Parameters<typeof hasProjectedActiveTurn>[0] }>;

function isTurnInFlight(session: TurnFacts, status: Pick<SessionStatus, 'awareness'>): boolean {
    return hasProjectedActiveTurn(session.latestTurnStatus) || status.awareness.operational.primary === 'working';
}

/**
 * Stalled (ORC O7, §3.5): the Session's presence is offline while one of its own turns is in flight.
 * Its reports never make it stalled — `withOutstandingReports` only keeps it from being settled — so an
 * offline lead waiting on working reports reads as offline and unfinished, not stalled.
 */
export function sessionWorkStalledFromStatus(session: TurnFacts, status: Pick<SessionStatus, 'awareness'>): boolean {
    return status.awareness.runtime === 'offline' && isTurnInFlight(session, status);
}

export function readSessionWorkStalled(session: Parameters<typeof getSessionStatus>[0], nowMs: number): boolean {
    return sessionWorkStalledFromStatus(session, getSessionStatus(session, nowMs, { workingTextMode: 'static' }));
}
