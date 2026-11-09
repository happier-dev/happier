import type { FollowDeliveryProjectionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';
import type { Message } from '@happier-dev/session-core/messages';

type DeliveryMessage = Readonly<{ localId?: string | null; followDeliveryProjection?: FollowDeliveryProjectionV1 }>;

const UNKNOWN_DELIVERY: FollowDeliveryProjectionV1 = { status: null, reason: null };

/** Exact input correlation owns both the original's visibility and its wake notice's placement. */
export function indexFollowWorkerCardsByInputLocalId(
    messages: Readonly<Record<string, Message>>,
    messageIds: readonly string[] = Object.keys(messages),
): ReadonlyMap<string, string> {
    const cards = new Map<string, string>();
    for (const id of messageIds) {
        const message = messages[id];
        if (message?.kind === 'agent-event' && message.event.type === 'worker-update'
            && message.event.followInputLocalId && !cards.has(message.event.followInputLocalId)) {
            cards.set(message.event.followInputLocalId, message.id);
        }
    }
    return cards;
}

/** Index only already-projected, exact input/batch messages; card events are never evidence by proximity. */
export function indexFollowDeliveryByLocalId(messages: Readonly<Record<string, DeliveryMessage>>): ReadonlyMap<string, FollowDeliveryProjectionV1 | null> {
    const byLocalId = new Map<string, FollowDeliveryProjectionV1 | null>();
    for (const message of Object.values(messages)) {
        const localId = message.localId;
        const projection = message.followDeliveryProjection;
        if (!localId || !projection) continue;
        const previous = byLocalId.get(localId);
        if (previous === undefined) byLocalId.set(localId, projection);
        else if (previous && (previous.status !== projection.status || previous.reason !== projection.reason)) byLocalId.set(localId, null);
    }
    return byLocalId;
}

export function projectWorkerCardDelivery(event: Readonly<{
    followInputLocalId?: string;
    followWakeEventLocalId?: string;
    ownProjection?: FollowDeliveryProjectionV1;
}>, byLocalId: ReadonlyMap<string, FollowDeliveryProjectionV1 | null>): FollowDeliveryProjectionV1 {
    const correlatedLocalId = event.followInputLocalId ?? event.followWakeEventLocalId;
    if (correlatedLocalId) return byLocalId.get(correlatedLocalId) ?? UNKNOWN_DELIVERY;
    return event.ownProjection ?? UNKNOWN_DELIVERY;
}
