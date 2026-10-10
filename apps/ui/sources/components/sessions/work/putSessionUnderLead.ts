import { Modal } from '@/modal';
import { getStorage } from '@/sync/domains/state/storage';
import { setSessionReportsTo } from '@/sync/ops/relations/setSessionReportsTo';
import { loadSessionReportsToEligibility } from '@/sync/ops/relations/sessionReportsToEligibility';
import { t } from '@/text';

import { canDropSessionUnder } from './putUnderCandidates';
import { selectSessionRelationRecords } from './reportSubtree';

/** The words for a refused `session.reports_to.set` — shared by "Put under…" and the list drag. */
export function describeReportsToRefusal(errorCode: string | undefined): string {
    switch (errorCode) {
        case 'reports_to_cycle':
            return t('sessionWork.putUnder.errors.cycle');
        case 'reports_to_cas_conflict':
            return t('sessionWork.putUnder.errors.changed');
        case 'reports_to_forbidden':
            return t('sessionWork.putUnder.errors.forbidden');
        default:
            return t('sessionWork.putUnder.errors.failed');
    }
}

export type PutSessionUnderLeadResult = 'applied' | 'not-eligible' | 'refused' | 'unknown';

/**
 * The Sessions-list drop "put this Session under that one" (R-03). Re-checks the drop against the
 * latest store (the list kept moving while the person dragged), sends the one
 * `session.reports_to.set` Action with the lead the store holds now as the expected current lead,
 * and says a refusal in words. The server's fence and compare-and-set decide.
 */
export async function putSessionUnderLead(input: Readonly<{
    serverId: string | null;
    sessionId: string;
    leadSessionId: string;
    signal?: AbortSignal;
    accountId?: string;
}>): Promise<PutSessionUnderLeadResult> {
    const initialState = getStorage().getState();
    const initialSessions = selectSessionRelationRecords(initialState.sessions, input.serverId, initialState.sessionListRowsByServerId);
    if (!input.serverId || (initialSessions[input.sessionId]?.serverId ?? null) !== input.serverId
        || (initialSessions[input.leadSessionId]?.serverId ?? null) !== input.serverId) return 'not-eligible';
    const facts = await loadSessionReportsToEligibility({
        serverId: input.serverId, sessionId: input.sessionId, candidateSessionIds: [input.leadSessionId], signal: input.signal,
    });
    const state = getStorage().getState();
    const sessions = selectSessionRelationRecords(state.sessions, input.serverId, state.sessionListRowsByServerId);
    if (!canDropSessionUnder(sessions, input.sessionId, input.leadSessionId, facts, {
        serverId: input.serverId, ...(input.accountId ? { accountId: input.accountId } : {}),
    })) {
        facts?.dispose();
        return 'not-eligible';
    }
    let errorCode: string | undefined;
    try {
        const result = await setSessionReportsTo({
            sessionId: input.sessionId,
            leadSessionId: input.leadSessionId,
            expectedLeadSessionId: sessions[input.sessionId]?.reportsTo?.sessionId ?? null,
            serverId: input.serverId,
            signal: input.signal,
            expectedAccountId: facts?.accountId,
        });
        if (result.ok) return 'applied';
        errorCode = result.errorCode;
    } catch {
        errorCode = undefined;
    } finally {
        facts?.dispose();
    }
    // A lost response or malformed/transport failure cannot prove that no edge was written.
    if (!errorCode || !['reports_to_cycle', 'reports_to_cas_conflict', 'reports_to_forbidden'].includes(errorCode)) return 'unknown';
    Modal.alert(t('sessionWork.putUnder.title'), describeReportsToRefusal(errorCode));
    return 'refused';
}
