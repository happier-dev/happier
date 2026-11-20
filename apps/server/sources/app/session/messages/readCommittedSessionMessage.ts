import { decodeStoredSessionMessage } from "@/storage/sessionMessageContent";
import type { Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import { buildSessionMessagePublicationWhere, loadSessionTranscriptPublication, isExternalShareableSessionTurnVisible } from '@/app/session/sessionTranscriptPublicationPolicy';
import { parseStoredSessionTurn } from '@/app/session/turns/parseSessionTurnState';
import { projectSessionMessageAccountActors } from './projectSessionMessageAccountActors';
import { isUnclaimedUnavailableExecutionRunInput } from '@/app/session/pending/selectPendingProviderInvocation';
import { normalizePendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { normalizePendingDeliveryStatusV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

/** Exact committed reads share transcript publication and current credential admission. */
export async function readCommittedSessionMessageInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
    /** Current publisher locality from the existing server owner, never client input. */
    targetMachineId?: string | null;
}> & (Readonly<{ messageId: string }> | Readonly<{ localId: string }>)) {
    const accessDecision = await resolveSessionAccessForOperation(tx, { accountId: input.accountId,
        sessionId: input.sessionId, authentication: input.authentication, capability: 'readTranscript',
        apiTokenAction: { actionId: 'session.transcript.get', targetMachineId: input.targetMachineId } });
    if (accessDecision.status !== 'allowed') return { row: null, accessDecision, accountActor: null, inputDisposition: null, inputDeliveryIssue: null };
    const publication = await loadSessionTranscriptPublication(tx, input.sessionId);
    const row = await tx.sessionMessage.findFirst({
        where: buildSessionMessagePublicationWhere({
            where: {
                sessionId: input.sessionId,
                ...('messageId' in input ? { id: input.messageId } : { localId: input.localId }),
            },
            publication,
        }),
        select: { contentBytes: true,
            id: true, seq: true, localId: true, sidechainId: true, messageRole: true, content: true,
            deliveryResolution: true, acceptedTurnKind: true, acceptedTurnId: true, turnStartWitnessId: true,
            createdAt: true, updatedAt: true, sourceCreatedAt: true, sourceUpdatedAt: true,
            transcriptObservationProvenance: true, inputAdmissionReceipt: true, authorAccountId: true,
        },
    }).then(row => decodeStoredSessionMessage(row));
    // Before the Home turn witness, the exact Pending original owns delivery.
    // Recovery can also be refused before creating a transcript row.
    const pending = 'localId' in input && (!row || row.messageRole === 'user' && !row.sidechainId && !row.turnStartWitnessId)
      ? await tx.sessionPendingMessage.findUnique({
        where: { sessionId_localId: { sessionId: input.sessionId, localId: input.localId } },
        select: { localId: true, targetExecutionRunId: true, requestedAction: true, status: true,
            deliveryState: true, deliveryBlockedReason: true, providerAction: true, updatedAt: true },
    }) : null;
    const inputDisposition = !row && pending?.status === 'queued'
        && normalizePendingRequestedActionV1(pending.requestedAction, 'stored').kind === 'recover_execution_run'
        && isUnclaimedUnavailableExecutionRunInput(pending.targetExecutionRunId, pending)
        ? { localId: pending.localId, result: { status: 'rejected' as const, code: 'session_input_target_unavailable' as const } }
        : null;
    const delivery = pending && normalizePendingDeliveryStatusV1(pending);
    const inputDeliveryIssue: SessionRuntimeIssueV1 | null = row && pending?.targetExecutionRunId === null && delivery?.status === 'blocked'
        && delivery.reason === 'team_access_removed'
        ? { v: 1, scope: 'primary_session', status: 'failed', code: delivery.reason,
            source: 'team_credential', occurredAt: pending.updatedAt.getTime(),
            failureCause: { phase: 'turn_start', failureReason: 'permission_denied', providerErrorCode: delivery.reason } }
        : null;
    const turnRow = 'localId' in input && row?.turnStartWitnessId ? await tx.sessionTurn.findUnique({ where: {
        sessionId_turnId: { sessionId: input.sessionId, turnId: row.turnStartWitnessId },
    } }) : null;
    const turn = turnRow && isExternalShareableSessionTurnVisible({ row: turnRow, publication })
        ? parseStoredSessionTurn(turnRow) : null;
    return {
        row: row ? { ...row, turn } : null,
        accessDecision,
        inputDisposition,
        inputDeliveryIssue,
        accountActor: row ? (await projectSessionMessageAccountActors(tx, [row]))[0] ?? null : null,
    };
}
