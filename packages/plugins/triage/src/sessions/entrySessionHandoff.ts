import type { ActionSessionAddressV1 } from '@happier-dev/plugin-sdk/sessions';
import { TRIAGE_DEFAULT_FIX_ACTION_ID_V1, type TriageSessionHandoffInputV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageEntrySessionStartRequestV1 } from './entrySessionStartController.js';

/** Native Send is an explicit delivery choice; a new destination keeps the catalog choice. */
export function buildTriageEntrySessionHandoffV1(
    request: TriageEntrySessionStartRequestV1,
    session?: ActionSessionAddressV1,
): TriageSessionHandoffInputV1 {
    const entry = { entryRef: request.entryRef, sourceInstanceId: request.sourceInstance.sourceInstanceId };
    return {
        task: request.requestedTask ?? (request.action.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1 ? 'fix' : 'investigate'),
        configuredActionId: request.action.actionId,
        context: session === undefined ? { kind: 'entries', entries: [entry], destination: 'single' } : { kind: 'entry', entry },
        evidence: [{ kind: 'entry', entry }],
        sessionChoice: session === undefined ? { kind: 'configured' } : { kind: 'existing', session: session.sessionId },
        agentChoice: { kind: 'configured' }, delivery: session === undefined ? 'configured' : 'send',
    };
}
