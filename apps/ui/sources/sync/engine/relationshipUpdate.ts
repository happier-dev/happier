export type NormalizedRelationshipUpdate = {
    fromUserId: string;
    toUserId: string;
    status: string;
    timestamp: number;
    action?: unknown;
    fromUser?: unknown;
    toUser?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeRelationshipUpdatedUpdateBody(
    input: unknown,
    opts: { currentUserId: string | null },
): NormalizedRelationshipUpdate | null {
    if (!isRecord(input)) {
        return null;
    }

    const maybeFromUserId = input.fromUserId;
    const maybeToUserId = input.toUserId;
    const maybeStatus = input.status;
    const maybeTimestamp = input.timestamp;

    // Preferred/rich shape
    if (
        typeof maybeFromUserId === 'string' &&
        typeof maybeToUserId === 'string' &&
        typeof maybeStatus === 'string' &&
        typeof maybeTimestamp === 'number'
    ) {
        return {
            fromUserId: maybeFromUserId,
            toUserId: maybeToUserId,
            status: maybeStatus,
            timestamp: maybeTimestamp,
            action: input.action,
            fromUser: input.fromUser,
            toUser: input.toUser,
        };
    }

    // Legacy/minimal server shape: relationship between current user and `uid`.
    const uid = input.uid;
    if (typeof uid !== 'string') {
        return null;
    }
    if (typeof maybeStatus !== 'string') {
        return null;
    }
    if (typeof maybeTimestamp !== 'number') {
        return null;
    }

    const currentUserId = opts.currentUserId;
    if (!currentUserId) {
        return null;
    }

    return {
        fromUserId: currentUserId,
        toUserId: uid,
        status: maybeStatus,
        timestamp: maybeTimestamp,
    };
}

