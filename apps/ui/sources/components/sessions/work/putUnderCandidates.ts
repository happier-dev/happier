import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionReportsToEligibilitySnapshot } from '@/sync/ops/relations/sessionReportsToEligibility';

type SessionRecord = Readonly<Record<string, Session>>;

export type PutUnderEligibility = Readonly<{ allowed: true; expectedLeadSessionId: string | null }> | Readonly<{
    allowed: false;
    reason: 'unavailable' | 'different_home' | 'archived' | 'input' | 'read' | 'pairwise' | 'cycle' | 'already_under';
}>;
export type PutUnderScope = Readonly<{ serverId?: string | null; accountId?: string; allowCurrentLead?: boolean }>;

/** Structural exclusions are local; endpoint/context admission comes only from the Home owner. */
export function resolvePutUnderEligibility(
    sessions: SessionRecord, sessionId: string, leadSessionId: string,
    facts?: SessionReportsToEligibilitySnapshot | null, scope: PutUnderScope = {},
): PutUnderEligibility {
    const session = sessions[sessionId];
    const candidate = sessions[leadSessionId];
    if (!session || !candidate) return { allowed: false, reason: 'unavailable' };
    const serverId = session.serverId ?? null;
    if ((candidate.serverId ?? null) !== serverId
        || (scope.serverId !== undefined && scope.serverId !== serverId)) return { allowed: false, reason: 'different_home' };
    if (session.id === candidate.id) return { allowed: false, reason: 'cycle' };
    if (session.archivedAt != null || candidate.archivedAt != null) return { allowed: false, reason: 'archived' };
    if (session.access?.capabilities.readTranscript !== true || candidate.access?.capabilities.readTranscript !== true) return { allowed: false, reason: 'read' };
    if (session.access?.capabilities.submitAgentInput !== true || candidate.access?.capabilities.submitAgentInput !== true) return { allowed: false, reason: 'input' };
    const seen = new Set<string>([session.id]);
    let cursor: string | null = candidate.id;
    while (cursor) {
        if (seen.has(cursor)) return { allowed: false, reason: 'cycle' };
        seen.add(cursor);
        const ancestor: Session | undefined = sessions[cursor];
        // An unmounted/unloaded ancestor is not proof of a cycle; the Home's full tree decides.
        if (!ancestor) break;
        if ((ancestor.serverId ?? null) !== serverId) return { allowed: false, reason: 'unavailable' };
        cursor = ancestor.reportsTo?.sessionId ?? null;
    }
    if (!scope.allowCurrentLead && session.reportsTo?.sessionId === candidate.id) return { allowed: false, reason: 'already_under' };
    if (!facts || !facts.isCurrent() || facts.serverId !== serverId || facts.sessionId !== session.id
        || (scope.accountId !== undefined && facts.accountId !== scope.accountId)
        || facts.currentLeadSessionId !== (session.reportsTo?.sessionId ?? null)) return { allowed: false, reason: 'unavailable' };
    const verdict = facts.readCandidate(candidate.id);
    return verdict ? verdict.allowed ? { allowed: true, expectedLeadSessionId: facts.currentLeadSessionId } : { allowed: false, reason: verdict.reason }
        : { allowed: false, reason: 'unavailable' };
}

/** Applicable targets include unavailable ones, so the chooser can explain current refusal. */
export function listPutUnderCandidateOptions(sessions: SessionRecord, session: Pick<Session, 'id' | 'serverId'>,
    facts?: SessionReportsToEligibilitySnapshot | null) {
    return Object.values(sessions)
        .map((candidate) => ({ candidate, eligibility: resolvePutUnderEligibility(sessions, session.id, candidate.id, facts, {
            serverId: session.serverId ?? null, allowCurrentLead: true,
        }) }))
        .filter(({ eligibility }) => eligibility.allowed || !['cycle', 'archived', 'different_home'].includes(eligibility.reason))
        .sort((a, b) => b.candidate.updatedAt - a.candidate.updatedAt);
}

/**
 * The Sessions offered by "Put under…", most recently active first. The current lead stays in the
 * list so the sheet can show where the Session sits now.
 */
export function listPutUnderCandidates(
    sessions: SessionRecord,
    session: Pick<Session, 'id' | 'serverId'>,
    facts?: SessionReportsToEligibilitySnapshot | null,
): readonly Session[] {
    return listPutUnderCandidateOptions(sessions, session, facts)
        .filter(({ eligibility }) => eligibility.allowed).map(({ candidate }) => candidate);
}

/**
 * Whether dragging `sessionId` onto `leadSessionId` in the Sessions list is a real "put under": the
 * person can steer the dragged Session (the same right "Put under…" asks for), the target could
 * lead it, and it is not already its lead (that drop would change nothing, so it shows no target).
 */
export function canDropSessionUnder(sessions: SessionRecord, sessionId: string, leadSessionId: string,
    facts?: SessionReportsToEligibilitySnapshot | null, scope?: PutUnderScope): boolean {
    return resolvePutUnderEligibility(sessions, sessionId, leadSessionId, facts, scope).allowed;
}
