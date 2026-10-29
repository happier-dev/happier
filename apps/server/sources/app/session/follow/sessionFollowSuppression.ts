import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { DiscussionProducerV1Schema } from '@happier-dev/protocol/discussions/content';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { isSessionFollowQuestionHandlerV1, type SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { SessionInputAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionStoredMessageContent } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';

import { TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { readDeliveryMuteScopesInTx } from './sessionDeliveryMuteService';
import { sessionFollowInputFrontiers, settleSessionFollowInputReasonsInTx,
    type SessionFollowInputRelation, type SessionFollowRuleProgressAdmission } from './sessionFollowRuleProgress';

/** Mute suppresses the original only when none of its selected reasons survives. */
export async function readSessionFollowInputSuppressionInTx(tx: Tx, input: Readonly<{
    accountId: string; destinationSessionId: string; receipt: SessionInputAdmissionReceiptV1;
}>): Promise<boolean | null> {
    const delivery = input.receipt.followDeliveryV1;
    const discussion = input.receipt.issuer === 'authenticatedMachine' ? input.receipt.discussionAddressing : undefined;
    if (!delivery && !discussion) return false;
    const scopes = await readDeliveryMuteScopesInTx(tx, { accountId: input.accountId,
        receiver: { kind: 'session', sessionId: input.destinationSessionId } });
    if (scopes === null) return null;
    if (!delivery && discussion) {
        const original = await tx.discussionMessage.findFirst({ where: { id: discussion.messageId,
            discussionId: discussion.discussionId, seq: discussion.throughSeq }, select: { producerV1: true } });
        if (!original) return null;
        const producer = original.producerV1 === null ? null : createStoredReadSchema(DiscussionProducerV1Schema).safeParse(original.producerV1);
        if (producer && !producer.success) return null;
        return isFollowDeliveryMutedV1(scopes, { source: { kind: 'discussion', discussionId: discussion.discussionId },
            ...(producer?.success && producer.data.kind === 'agent' ? { senderSessionId: producer.data.sessionId } : {}) });
    }
    if (!delivery) return false;
    const original = delivery.original;
    const candidate = 'sourceSessionId' in original
        ? { senderSessionId: original.sourceSessionId, source: { kind: 'session' as const, sessionId: original.sourceSessionId } }
        : { source: original.source, ...('sessionId' in original.source ? { senderSessionId: original.source.sessionId } : {}) };
    if (isFollowDeliveryMutedV1(scopes, candidate)) return true;
    if (isSessionFollowQuestionHandlerV1(delivery, input.destinationSessionId) || input.receipt.followRelations?.length) return false;
    const sources = input.receipt.followSources ?? [];
    return sources.length > 0 && sources.every(witness => isFollowDeliveryMutedV1(scopes,
        { source: { kind: 'rule', ruleId: witness.rule.ruleId } }));
}

/**
 * Reuse rejected-input custody for an authorized original encountered while muted.
 * It never enters the runnable queue or claims provider acceptance. Exact input
 * identity survives a later request carrier, unmute, restart and catch-up.
 */
export async function retainSuppressedFollowInputInTx(tx: Tx, input: Readonly<{
    destinationSessionId: string; localId: string; content: SessionStoredMessageContent;
    requestedAction: PendingRequestedActionV1; receipt: SessionInputAdmissionReceiptV1;
    position: number;
}>): Promise<void> {
    await tx.sessionPendingMessage.create({ data: {
        sessionId: input.destinationSessionId, localId: input.localId, messageRole: 'user',
        content: input.content, requestedAction: input.requestedAction, inputAdmissionReceipt: input.receipt,
        position: input.position, status: 'discarded', discardedAt: new Date(), discardedReason: 'session_input_muted',
    } });
}

/** Session originals also settle their existing relation/rule reasons atomically. */
export async function retainSuppressedSessionFollowInputInTx(tx: Tx, input: Parameters<typeof retainSuppressedFollowInputInTx>[1] & Readonly<{
    delivery: SessionFollowInputV1;
    progresses: readonly SessionFollowRuleProgressAdmission[];
    relations: readonly SessionFollowInputRelation[];
}>): Promise<void> {
    await retainSuppressedFollowInputInTx(tx, input);
    if (!await settleSessionFollowInputReasonsInTx(tx, { delivery: input.delivery,
        observed: sessionFollowInputFrontiers(input.delivery).observed,
        progresses: input.progresses, relations: input.relations })) throw new TransactionReplayRequiredError('follow-input-settlement-conflict');
}
