import { SessionTurnFactsV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import type { SessionMessageProvenance, SessionTurnFactsV1 } from '@happier-dev/protocol';

/** Host input facts, never inferred from prompt prose or mutable reportsTo edges. */
export function stampTurnFacts(input: Readonly<{
    sessionWorkDepth: number;
    provenance?: SessionMessageProvenance;
    hostContextOnly?: boolean;
    workflowInvocation?: Readonly<{ runId: string; invocationRecordId: string }>;
    workflowWorkDepth?: number;
}>): SessionTurnFactsV1 {
    const provenance = input.provenance;
    const invocation = input.workflowInvocation ?? (provenance?.kind === 'workflow_invocation'
        ? { runId: provenance.runId, invocationRecordId: provenance.invocationRecordId }
        : undefined);
    if (invocation) {
        return SessionTurnFactsV1Schema.parse({
            initiator: 'workflow', workDepth: input.workflowWorkDepth
                ?? (provenance?.kind === 'workflow_invocation' ? provenance.workDepth : undefined),
            workflowInvocation: invocation,
        });
    }
    if (input.hostContextOnly) {
        return SessionTurnFactsV1Schema.parse({ initiator: 'host', workDepth: input.sessionWorkDepth });
    }
    if (provenance?.kind === 'happierSession') {
        if (provenance.callerDepth === undefined) throw new Error('Agent input is missing host-stamped caller depth');
        return SessionTurnFactsV1Schema.parse({ initiator: 'agent_session', workDepth: provenance.callerDepth + 1 });
    }
    return { initiator: 'user', workDepth: 0 };
}
