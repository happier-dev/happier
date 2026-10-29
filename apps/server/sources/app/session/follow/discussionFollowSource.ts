import { isDeepStrictEqual } from 'node:util';
import { DISCUSSION_DEFAULT_PAGE_SIZE_V1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionMessageAddressingV1Schema, type DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/references';
import { DiscussionProducerV1Schema } from '@happier-dev/protocol/discussions/content';
import { deriveDiscussionFollowInputLocalIdV1, type SessionFollowDiscussionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { createSessionInputReplyProgressInTx } from '@/app/session/messages/sessionMessageReply';
import { invalidateSessionRelationProjectionsInTx } from '@/app/session/relations/sessionRelationChanges';
import type { Tx } from '@/storage/inTx';
import { createDeliveryMuteReaderInTx, isDeliveryMutedInTx } from './sessionDeliveryMuteService';
import { sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { FollowPolicyV1Schema, resolveFollowDeliveryV1, serializeFollowPolicyV1, type FollowEventV1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { readAccountFollowCreationPreferencesInTx } from './accountFollowCreationPreferences';
import { readAccountOtherFollowInTx } from './accountFollowService';
import { resolveDiscussionContextInTx } from '@/app/discussions/access';
import { projectReadableMessagesInTx } from '@/app/discussions/queries';
import { DISCUSSION_MESSAGE_SELECT } from '@/app/discussions/projection';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { SessionFollowDiscussionOccurrenceRoutesRequestV1, SessionFollowDiscussionOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

export type DiscussionFollowOccurrenceUnavailableCode = 'discussion_follow_unavailable' | 'discussion_unavailable'
    | 'discussion_message_absent' | 'discussion_message_unreadable' | 'discussion_message_invalid'
    | 'discussion_delivery_held' | 'discussion_occurrence_unavailable' | 'occurrence_absent';

/** Personal Follow reads original C3 messages, never executable participant addressing or an attention mirror. */
export async function observeAccountDiscussionFollowOccurrenceInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; request: SessionFollowDiscussionOccurrenceRoutesRequestV1;
    onUnavailable?: (code: DiscussionFollowOccurrenceUnavailableCode) => void;
}>): Promise<SessionFollowDiscussionOccurrenceV1 | null> {
    const { source, messageId } = input.request;
    const unavailable = (code: DiscussionFollowOccurrenceUnavailableCode) => { input.onUnavailable?.(code); return null; };
    const follow = await readAccountOtherFollowInTx(tx, { ...input, source });
    // A missing seed is unavailable custody, never an implicit history replay.
    if (!follow || follow.deliveredDiscussionSeq === null) return unavailable('discussion_follow_unavailable');
    const deliveredSeq = follow.deliveredDiscussionSeq;
    const context = await resolveDiscussionContextInTx(tx, { discussionId: source.discussionId,
        accountId: input.accountId, authentication: input.authentication });
    const discussion = await tx.discussion.findUnique({ where: { id: source.discussionId }, select: { archivedAt: true, anchorV1: true } });
    if (!context?.keyReadiness || !discussion || discussion.archivedAt !== null) return unavailable('discussion_unavailable');
    let afterSeq = deliveredSeq;
    for (;;) {
        const rows = await tx.discussionMessage.findMany({ where: { discussionId: source.discussionId,
            ...(messageId ? { id: messageId } : { seq: { gt: afterSeq } }) },
            select: DISCUSSION_MESSAGE_SELECT, orderBy: { seq: 'asc' }, take: DISCUSSION_DEFAULT_PAGE_SIZE_V1 });
        if (!rows.length) return unavailable(messageId ? 'discussion_message_absent' : 'occurrence_absent');
        const readable = await projectReadableMessagesInTx(tx, { actorAccountId: input.accountId,
            authentication: input.authentication, discussionId: source.discussionId, context, rows, discussion });
        if (!readable.ok) return unavailable('discussion_message_unreadable');
        for (const message of readable.value.messages) {
            const producer = message.producerV1;
            // These are protected append-owner facts: an absent producer is
            // admitted only for present-user ingress, never authored metadata.
            if (!producer && message.authorAccountId === input.accountId
                || producer?.kind === 'agent' && producer.actionRequestAttributionV1?.requester?.accountId === input.accountId) continue;
            if (!producer && message.authorAccountId === null) return unavailable('discussion_message_invalid');
            const event = { kind: producer ? 'message' as const : 'person_wrote' as const };
            if (!resolveFollowDeliveryV1({ policies: [follow.policy], event }).selected) continue;
            if (await isDeliveryMutedInTx(tx, { accountId: input.accountId, receiver: { kind: 'account' },
                candidate: { source, ...(producer?.kind === 'agent' ? { senderSessionId: producer.sessionId } : {}) } }) !== false) return unavailable('discussion_delivery_held');
            return { source, messageId: message.id, seq: message.seq, event,
                personal: { policy: follow.policy, alreadyRepresented: deliveredSeq >= message.seq } };
        }
        if (messageId || rows.length < DISCUSSION_DEFAULT_PAGE_SIZE_V1)
            return unavailable(messageId ? 'discussion_occurrence_unavailable' : 'occurrence_absent');
        afterSeq = rows[rows.length - 1]!.seq;
    }
}
/** Attachment and delivery progress belong to C1, never the policy-only participant row. */
export async function attachDiscussionFollowSourceInTx(tx: Tx, input: Readonly<{ discussionId: string; destinationSessionId: string }>): Promise<void> {
    const existing = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceDiscussionId_relation: {
        destinationSessionId: input.destinationSessionId, sourceDiscussionId: input.discussionId, relation: 'follower' } }, select: { sourceKey: true } });
    if (existing) return;
    const discussion = await tx.discussion.findUniqueOrThrow({ where: { id: input.discussionId }, select: { messageSeq: true } });
    const receiver = await tx.session.findUniqueOrThrow({ where: { id: input.destinationSessionId }, select: { accountId: true } });
    const defaults = await readAccountFollowCreationPreferencesInTx(tx, receiver.accountId);
    await tx.sessionFollowEdge.upsert({ where: { destinationSessionId_sourceDiscussionId_relation: {
        destinationSessionId: input.destinationSessionId, sourceDiscussionId: input.discussionId, relation: 'follower' } },
        create: { sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'discussion', discussionId: input.discussionId }),
            sourceDiscussionId: input.discussionId, destinationSessionId: input.destinationSessionId,
            relation: 'follower', policyJson: serializeFollowPolicyV1(defaults.discussionReceivePolicy), deliveredTranscriptSeq: discussion.messageSeq }, update: {} });
    await invalidateSessionRelationProjectionsInTx(tx, [input.destinationSessionId]);
}

/** Removing a binding destroys its C1 attachment; a later invite seeds the then-current sequence. */
export async function detachDiscussionFollowSourceInTx(tx: Tx, input: Readonly<{ discussionId: string; destinationSessionId?: string }>): Promise<void> {
    const edges = await tx.sessionFollowEdge.findMany({ where: { sourceDiscussionId: input.discussionId,
        ...(input.destinationSessionId ? { destinationSessionId: input.destinationSessionId } : {}) }, select: { destinationSessionId: true } });
    await tx.sessionFollowEdge.deleteMany({ where: { sourceDiscussionId: input.discussionId,
        ...(input.destinationSessionId ? { destinationSessionId: input.destinationSessionId } : {}) } });
    if (edges.length) await invalidateSessionRelationProjectionsInTx(tx, edges.map(edge => edge.destinationSessionId));
}

function receiptHasAddressing(value: unknown, addressing: DiscussionAddressingV1): boolean {
    const receipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(value);
    return receipt.success && receipt.data.issuer === 'authenticatedMachine'
        && receipt.data.admittedTarget?.sessionId === addressing.participantSessionId
        && isDeepStrictEqual(receipt.data.discussionAddressing, addressing);
}

/**
 * One oldest selected unsettled original per attachment. Pages use the
 * Discussion owner's indexed (discussionId, seq) traversal; settled originals
 * are batch-read by their existing exact Pending/materialized identity, including
 * rejected muted custody that never became executable input. The
 * delivered frontier normally excludes all prior accepted history. Unaddressed
 * rows since that frontier are revisited, not hidden behind an invented cap.
 * Receiver Pending owns check-in admission for its Account, including questions
 * authored by another Account. This source projection never skips an original
 * because its author and receiver belong to different Accounts.
 * Routing carries the persisted relation policy and committed addressing/author
 * classification; current creation defaults never reinterpret an attachment.
 */
export async function observeDiscussionFollowSourcesInTx(tx: Tx, input: Readonly<{
    destinationSessionId: string; destinationRuntimeAccountId: string;
}>, readDeliveryMuted = createDeliveryMuteReaderInTx(tx, {
    accountId: input.destinationRuntimeAccountId,
    receiver: { kind: 'session', sessionId: input.destinationSessionId },
})): Promise<SessionFollowDiscussionPendingObservationV1[]> {
    const edges = await tx.sessionFollowEdge.findMany({ where: { destinationSessionId: input.destinationSessionId,
        sourceDiscussionId: { not: null }, relation: 'follower' },
        select: { sourceDiscussionId: true, deliveredTranscriptSeq: true, policyJson: true }, orderBy: { sourceDiscussionId: 'asc' } });
    const observations: SessionFollowDiscussionPendingObservationV1[] = [];
    for (const edge of edges) {
        const discussionId = edge.sourceDiscussionId;
        if (!discussionId) continue;
        let policy: FollowPolicyV1;
        try {
            policy = createStoredReadSchema(FollowPolicyV1Schema).parse(JSON.parse(edge.policyJson));
        } catch {
            continue;
        }
        let afterSeq = edge.deliveredTranscriptSeq;
        for (;;) {
            const rows = await tx.discussionMessage.findMany({ where: { discussionId, seq: { gt: afterSeq } },
                select: { id: true, discussionId: true, seq: true, addressingV1: true, producerV1: true }, orderBy: { seq: 'asc' }, take: DISCUSSION_DEFAULT_PAGE_SIZE_V1 });
            if (!rows.length) break;
            const candidates = rows.flatMap(row => {
                const snapshot = createStoredReadSchema(DiscussionMessageAddressingV1Schema).safeParse(row.addressingV1);
                if (!snapshot.success || snapshot.data.throughSeq !== row.seq
                    || !snapshot.data.participantSessionIds.includes(input.destinationSessionId)) return [];
                const producer = row.producerV1 === null ? null : createStoredReadSchema(DiscussionProducerV1Schema).safeParse(row.producerV1);
                if (producer && !producer.success) return [];
                const event: FollowEventV1 = snapshot.data.watcherSessionIds?.includes(input.destinationSessionId)
                    ? { kind: producer?.success ? 'message' : 'person_wrote' }
                    : { kind: 'needs_you', type: 'decision', mode: 'wait' };
                const addressing = { discussionId, messageId: row.id, throughSeq: row.seq, participantSessionId: input.destinationSessionId };
                return [{ addressing, localId: deriveDiscussionFollowInputLocalIdV1(addressing), event,
                    original: { id: row.id, discussionId: row.discussionId, seq: row.seq, addressingV1: snapshot.data },
                    sourceSession: producer?.success && producer.data.kind === 'agent' ? producer.data.sourceSession : undefined,
                    senderSessionId: producer?.success && producer.data.kind === 'agent' ? producer.data.sessionId : undefined }];
            });
            const localIds = candidates.map(candidate => candidate.localId);
            const settled = localIds.length ? await Promise.all([
                tx.sessionPendingMessage.findMany({ where: { sessionId: input.destinationSessionId, localId: { in: localIds } }, select: { localId: true, inputAdmissionReceipt: true } }),
                tx.sessionMessage.findMany({ where: { sessionId: input.destinationSessionId, localId: { in: localIds } }, select: { localId: true, inputAdmissionReceipt: true } }),
            ]) : [];
            for (const candidate of candidates) {
                if (settled.flat().some(original => original.localId === candidate.localId && receiptHasAddressing(original.inputAdmissionReceipt, candidate.addressing))) continue;
                const reply = await createSessionInputReplyProgressInTx(tx, { accountId: input.destinationRuntimeAccountId,
                    reply: { mode: 'return', discussion: candidate.addressing,
                        ...(candidate.sourceSession ? { sourceSession: candidate.sourceSession } : {}) } });
                if (!reply) continue;
                // Confirmed mute still needs final Pending admission to retain
                // discarded original custody. Unknown policy is a retryable
                // hold; observation itself never claims an accepted effect.
                if (await readDeliveryMuted({ source: { kind: 'discussion', discussionId },
                    ...(candidate.senderSessionId ? { senderSessionId: candidate.senderSessionId } : {}),
                }) === null) continue;
                if (!resolveFollowDeliveryV1({ policies: [policy], event: candidate.event,
                    discussionInput: { addressing: candidate.addressing, original: candidate.original, reply } }).selected) continue;
                observations.push({ source: { kind: 'discussion', discussionId }, destinationSessionId: input.destinationSessionId,
                    addressing: candidate.addressing, policy, event: candidate.event });
                break;
            }
            if (observations.some(observation => observation.source.discussionId === discussionId) || rows.length < DISCUSSION_DEFAULT_PAGE_SIZE_V1) break;
            afterSeq = rows[rows.length - 1]!.seq;
        }
    }
    return observations;
}

/** Pending admission re-enters C1's exact current occurrence, not caller-authored routing. */
export async function admitDiscussionFollowAddressingInTx(tx: Tx, input: Readonly<{ accountId: string; discussion: DiscussionAddressingV1 }>): Promise<boolean> {
    const current = await observeDiscussionFollowSourcesInTx(tx, { destinationSessionId: input.discussion.participantSessionId,
        destinationRuntimeAccountId: input.accountId });
    return current.some(observation => isDeepStrictEqual(observation.addressing, input.discussion));
}

/** Accepted existing Pending custody is the effect: commit its ACK atomically, not at a second queue. */
export async function acknowledgeDiscussionFollowInputInTx(tx: Tx, input: Readonly<{ addressing: DiscussionAddressingV1; localInputId: string }>): Promise<void> {
    if (deriveDiscussionFollowInputLocalIdV1(input.addressing) !== input.localInputId) throw new Error('Discussion Follow input identity mismatch');
    const original = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
        sessionId: input.addressing.participantSessionId, localId: input.localInputId } }, select: { status: true, inputAdmissionReceipt: true } });
    if (!original || original.status !== 'queued' || !receiptHasAddressing(original.inputAdmissionReceipt, input.addressing)) throw new Error('Discussion Follow Pending acceptance is unavailable');
    // Advance only through this exact accepted original; receiver admission
    // retains unaccepted questions before any Pending receipt or source ACK.
    const changed = await tx.sessionFollowEdge.updateMany({ where: { destinationSessionId: input.addressing.participantSessionId,
        sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'discussion', discussionId: input.addressing.discussionId }),
        relation: 'follower', deliveredTranscriptSeq: { lt: input.addressing.throughSeq } }, data: { deliveredTranscriptSeq: input.addressing.throughSeq } });
    if (changed.count !== 1) throw new Error('Discussion Follow attachment changed before Pending acceptance');
}
