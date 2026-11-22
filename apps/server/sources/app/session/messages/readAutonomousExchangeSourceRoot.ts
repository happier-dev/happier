import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionInputAdmissionReceiptV1Schema, type SessionInputAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { Tx } from '@/storage/inTx';
import type { AutonomousExchangeRootV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { DiscussionMessageAddressingV1Schema } from '@happier-dev/protocol/discussions/references';

export const AUTONOMOUS_EXCHANGE_SOURCE_INPUT_SELECT = {
    localId: true,
    acceptedTurnId: true,
    targetExecutionRunId: true,
    inputAdmissionReceipt: true,
    turnStartWitnessId: true,
    autonomousExchangeRootSessionId: true,
    autonomousExchangeRootLocalId: true,
} as const;

type SourceInput = Readonly<{
    localId: string | null;
    acceptedTurnId: string | null;
    targetExecutionRunId: string | null;
    inputAdmissionReceipt: unknown;
    turnStartWitnessId: string | null;
    autonomousExchangeRootSessionId: string | null;
    autonomousExchangeRootLocalId: string | null;
}>;

export type AutonomousExchangeRoot = AutonomousExchangeRootV1;

function readAutonomousExchangeRootReceiptForAccount(value: unknown, accountId: string, sessionId: string): SessionInputAdmissionReceiptV1 | null {
    const receipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(value);
    return receipt.success && (receipt.data.issuer === 'authenticatedAccount'
        ? receipt.data.actorAccountId === accountId
        : receipt.data.admittedTarget?.accountId === accountId && receipt.data.admittedTarget.sessionId === sessionId)
        ? receipt.data : null;
}

/** A receiving Account controls its own admitted root, never a foreign actor. */
export function isAutonomousExchangeRootReceiptForAccount(value: unknown, accountId: string, sessionId: string): boolean {
    return readAutonomousExchangeRootReceiptForAccount(value, accountId, sessionId) !== null;
}

function isDirectAutonomousExchangeRootReceipt(receipt: SessionInputAdmissionReceiptV1 | null): boolean {
    return receipt !== null && !receipt.followDeliveryV1 && !receipt.followSources && !receipt.followRelations
        && (receipt.issuer === 'authenticatedAccount' || !receipt.discussionAddressing);
}

/** A person-message wake can run before the source's provider acceptance arrives. */
export async function readCommittedPersonFollowRootInTx(tx: Tx, input: Readonly<{
    accountId: string; sourceSessionId: string; sourceMessage: { localId: string; seq: number };
}>): Promise<AutonomousExchangeRoot | undefined> {
    const { accountId, sourceSessionId, sourceMessage } = input;
    const message = await tx.sessionMessage.findUnique({
        where: { sessionId_localId: { sessionId: sourceSessionId, localId: sourceMessage.localId },
            seq: sourceMessage.seq, session: { accountId }, messageRole: 'user',
            sidechainId: null, targetExecutionRunId: null, autonomousExchangeCause: null },
        select: { inputAdmissionReceipt: true },
    });
    const receipt = readAutonomousExchangeRootReceiptForAccount(message?.inputAdmissionReceipt, accountId, sourceSessionId);
    if (isDirectAutonomousExchangeRootReceipt(receipt)) return { sessionId: sourceSessionId, localId: sourceMessage.localId };
}

/** Foreign causes join the receiver's current local input/root, not the sender's private lineage. */
export async function readReceiverAutonomousExchangeRootInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string; selection?: 'latest_person';
}>): Promise<AutonomousExchangeRoot | null> {
    if (input.selection === 'latest_person') {
        // Run wakes belong to the receiving person's exchange, not the root
        // inherited by a later agent input. Follow notices are not person input.
        let beforeSeq: number | undefined;
        while (true) {
            const candidate = await tx.sessionMessage.findFirst({
                where: { sessionId: input.sessionId, targetExecutionRunId: null, sidechainId: null, authorAccountId: input.accountId,
                    messageRole: 'user', localId: { not: null }, autonomousExchangeCause: null,
                    ...(beforeSeq === undefined ? {} : { seq: { lt: beforeSeq } }) },
                orderBy: { seq: 'desc' },
                select: { seq: true, localId: true, inputAdmissionReceipt: true },
            });
            if (!candidate) return null;
            const receipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(candidate.inputAdmissionReceipt);
            if (candidate.localId && receipt.success && receipt.data.issuer === 'authenticatedAccount'
                && receipt.data.actorAccountId === input.accountId && !receipt.data.followDeliveryV1
                && !receipt.data.followSources && !receipt.data.followRelations) {
                return { sessionId: input.sessionId, localId: candidate.localId };
            }
            beforeSeq = candidate.seq;
        }
    }
    const current = await tx.sessionMessage.findFirst({
        where: { sessionId: input.sessionId, targetExecutionRunId: null, messageRole: 'user', localId: { not: null } },
        orderBy: { seq: 'desc' },
        select: { localId: true, inputAdmissionReceipt: true,
            autonomousExchangeRootSessionId: true, autonomousExchangeRootLocalId: true },
    });
    if (!current) return null;
    if (current.autonomousExchangeRootSessionId && current.autonomousExchangeRootLocalId) {
        return { sessionId: current.autonomousExchangeRootSessionId, localId: current.autonomousExchangeRootLocalId };
    }
    return current.localId && isAutonomousExchangeRootReceiptForAccount(current.inputAdmissionReceipt, input.accountId, input.sessionId)
        ? { sessionId: input.sessionId, localId: current.localId } : null;
}

/** The sole root decision for exact source input(s), including Follow batches. */
export async function readAutonomousExchangeSourceRoot(input: Readonly<{
    tx: Tx;
    sourceSessionId: string;
    actorAccountId: string;
    expectedTurnId?: string;
    sourceInputs: readonly SourceInput[];
}>): Promise<Readonly<{ status: 'found'; root: AutonomousExchangeRoot }>
    | Readonly<{ status: 'unavailable' | 'invalid' }>> {
    let root: AutonomousExchangeRoot | null = null;
    // An accepted original can share the provider's Turn as represented context.
    // When present, the start witness identifies which input supplied that Turn's root.
    const witnessedTurns = new Set<string>();
    for (const sourceInput of input.sourceInputs) {
        if (sourceInput.acceptedTurnId && sourceInput.turnStartWitnessId === sourceInput.acceptedTurnId) {
            witnessedTurns.add(sourceInput.acceptedTurnId);
        }
    }
    for (const sourceInput of input.sourceInputs) {
        if (sourceInput.targetExecutionRunId !== null) return { status: 'unavailable' };
        if (!sourceInput.acceptedTurnId || input.expectedTurnId
            && sourceInput.acceptedTurnId !== input.expectedTurnId) return { status: 'invalid' };
        if (witnessedTurns.has(sourceInput.acceptedTurnId)
            && sourceInput.turnStartWitnessId !== sourceInput.acceptedTurnId) continue;
        const inheritedSessionId = sourceInput.autonomousExchangeRootSessionId;
        const inheritedLocalId = sourceInput.autonomousExchangeRootLocalId;
        if ((inheritedSessionId === null) !== (inheritedLocalId === null)) return { status: 'invalid' };
        const receipt = readAutonomousExchangeRootReceiptForAccount(sourceInput.inputAdmissionReceipt,
            input.actorAccountId, input.sourceSessionId);
        // Protected CLI originals use Machine admission too. Their accepted,
        // exact Account/Session receipt is already an owned root; this does not
        // turn a Follow or Discussion carrier into a new person input.
        const directOriginal = isDirectAutonomousExchangeRootReceipt(receipt);
        let candidate = inheritedSessionId && inheritedLocalId
            ? { sessionId: inheritedSessionId, localId: inheritedLocalId }
            : directOriginal && sourceInput.localId
                ? { sessionId: input.sourceSessionId, localId: sourceInput.localId }
                : null;
        // A person's Discussion request enters through Machine admission. Its
        // committed question, not that carrier or user-role text, proves a new
        // human cause. Agent/workflow questions must retain their existing root.
        const addressing = receipt?.issuer === 'authenticatedMachine'
            ? receipt.discussionAddressing : undefined;
        if (!candidate && addressing && addressing.participantSessionId === input.sourceSessionId
            && sourceInput.localId === deriveDiscussionFollowInputLocalIdV1(addressing)) {
            const question = await input.tx.discussionMessage.findUnique({ where: { id: addressing.messageId },
                select: { discussionId: true, seq: true, producerV1: true, addressingV1: true } });
            const addressed = createStoredReadSchema(DiscussionMessageAddressingV1Schema).safeParse(question?.addressingV1);
            if (question && question.discussionId === addressing.discussionId && question.seq === addressing.throughSeq
                && question.producerV1 === null && addressed.success && addressed.data.throughSeq === addressing.throughSeq
                && addressed.data.participantSessionIds.includes(input.sourceSessionId)
                && !addressed.data.watcherSessionIds?.includes(input.sourceSessionId)) {
                candidate = { sessionId: input.sourceSessionId, localId: sourceInput.localId };
            }
        }
        if (!candidate) return { status: 'unavailable' };
        if (root && (root.sessionId !== candidate.sessionId || root.localId !== candidate.localId)) {
            return { status: 'unavailable' };
        }
        root = candidate;
    }
    return root ? { status: 'found', root } : { status: 'unavailable' };
}
