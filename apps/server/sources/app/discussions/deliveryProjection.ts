import type { DiscussionMessageV1, DiscussionParticipantDeliveryV1 } from '@happier-dev/protocol/discussions/models';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { readPendingDiscussionFollowInputsInTx } from '@/app/session/follow/discussionFollowSource';
import { readHeldDiscussionPendingInputsInTx } from '@/app/session/pending/pendingMessageService';
import { readDiscussionReplyPublicationFailuresInTx } from '@/app/session/messages/sessionMessageReply';
import type { Tx } from '@/storage/inTx';

/** Read and mutation responses share the same durable receiver-custody projection. */
export async function projectDiscussionMessageDeliveriesInTx(tx: Tx, messages: readonly DiscussionMessageV1[]): Promise<DiscussionMessageV1[]> {
    const addresses = messages.flatMap(message => (message.addressingV1?.participantSessionIds ?? []).map(participantSessionId => ({
        discussionId: message.discussionId, messageId: message.id, throughSeq: message.seq, participantSessionId,
    })));
    const byId = new Map(messages.map(message => [message.id, message]));
    const [held, failures, pending] = await Promise.all([
        readHeldDiscussionPendingInputsInTx(tx, addresses),
        readDiscussionReplyPublicationFailuresInTx(tx, addresses),
        // Watcher delivery is informational; an explicit ask carries the answer obligation.
        readPendingDiscussionFollowInputsInTx(tx, addresses.filter(address =>
            !byId.get(address.messageId)?.addressingV1?.watcherSessionIds?.includes(address.participantSessionId))),
    ]);
    return messages.map(message => {
        const deliveries = (message.addressingV1?.participantSessionIds ?? []).flatMap((participantSessionId): DiscussionParticipantDeliveryV1[] => {
            const localId = deriveDiscussionFollowInputLocalIdV1({ discussionId: message.discussionId,
                messageId: message.id, throughSeq: message.seq, participantSessionId });
            const failure = failures.get(localId);
            if (failure) return [{ participantSessionId, disposition: 'failed', failure }];
            if (held.has(localId)) return [{ participantSessionId, disposition: 'held', code: 'session_input_target_unavailable' }];
            return pending.has(localId) ? [{ participantSessionId, disposition: 'pending' }] : [];
        });
        return deliveries.length ? { ...message, participantDeliveryV1: deliveries } : message;
    });
}
