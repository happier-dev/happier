import { isPendingDeliveryProviderEffectPossibleV1, normalizePendingDeliveryStatusV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import type { PendingReorderInputV1 } from '@happier-dev/protocol/actions/listReorderAction';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { isPendingMessageForRecipient } from './pendingMessageRecipient';

/** Admission and execution share current queue membership, never the carry's row array. */
export function resolvePendingReorderIds(messages: readonly PendingMessage[], input: PendingReorderInputV1): string[] | null {
    const queue = messages.filter(message => message.source !== 'local_outbound'
        && !(message.deliveryStatus === 'accepted' && message.source !== 'server_pending')
        && (!message.pendingOutboxScope || areServerAccountScopesEqual(message.pendingOutboxScope, input.scope))
        && isPendingMessageForRecipient(message, input.recipient ?? undefined));
    const identity = (id: string) => queue.find(message => message.id === id || message.localId === id);
    const source = identity(input.sourceId);
    const anchor = input.position.anchorId === null ? null : identity(input.position.anchorId);
    if (!source || (input.position.anchorId !== null && !anchor)) return null;
    const ids = queue.map(message => message.localId ?? message.id);
    if (new Set(ids).size !== ids.length) return null;
    const order = resolveAnchoredListMoveV1(ids, source.localId ?? source.id, {
        ...input.position, anchorId: anchor ? anchor.localId ?? anchor.id : null,
    });
    if (!order) return null;
    for (const [offset, message] of queue.entries()) {
        const status = normalizePendingDeliveryStatusV1({ status: 'queued',
            deliveryState: message.pendingDeliveryStatus === 'server_queued' ? null : message.pendingDeliveryStatus,
            deliveryBlockedReason: message.pendingDeliveryBlockedReason });
        if (isPendingDeliveryProviderEffectPossibleV1(status) && order[offset] !== ids[offset]) return null;
    }
    return order;
}
