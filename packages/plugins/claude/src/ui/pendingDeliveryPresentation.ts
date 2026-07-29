export type ClaudePendingDeliveryDetail = 'custody_observed' | 'awaiting_acceptance';
export type ClaudePendingDeliveryLabelKey = 'session.pendingMessages.deliveryStatus.queuedInClaude';

export function resolveClaudePendingDeliveryLabelKey(input: Readonly<{
    localId: string | null;
    detail: ClaudePendingDeliveryDetail | undefined;
    custodyObservedLocalId: unknown;
}>): ClaudePendingDeliveryLabelKey | null {
    if (input.detail === 'custody_observed') {
        return 'session.pendingMessages.deliveryStatus.queuedInClaude';
    }
    if (
        typeof input.localId === 'string'
        && input.localId.length > 0
        && typeof input.custodyObservedLocalId === 'string'
        && input.custodyObservedLocalId.length > 0
        && input.localId === input.custodyObservedLocalId
    ) {
        return 'session.pendingMessages.deliveryStatus.queuedInClaude';
    }
    return null;
}
