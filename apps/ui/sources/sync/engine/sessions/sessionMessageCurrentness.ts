export type SessionReceivedMessages = Map<string, Map<string, number>>;

export function getOrCreateSessionReceivedMessages(
    sessionReceivedMessages: SessionReceivedMessages,
    sessionId: string,
): Map<string, number> {
    let messages = sessionReceivedMessages.get(sessionId);
    if (!messages) {
        messages = new Map<string, number>();
        sessionReceivedMessages.set(sessionId, messages);
    }
    return messages;
}

/**
 * A page may replay an exact marked update once, but it may never travel
 * backward over a newer row already applied by a page or socket delivery.
 */
export function isSessionMessageRowCurrent(params: Readonly<{
    existingUpdatedAt: number | undefined;
    incomingUpdatedAt: number;
    isAuthoritativeUpdate: boolean;
}>): boolean {
    return params.existingUpdatedAt === undefined
        || params.incomingUpdatedAt > params.existingUpdatedAt
        || (params.isAuthoritativeUpdate && params.incomingUpdatedAt === params.existingUpdatedAt);
}

/**
 * The shared per-row page/socket watermark is monotonic. A later delivery may
 * advance it, but an older response must never move it backward.
 */
export function advanceSessionReceivedMessageCurrentness(
    sessionReceivedMessages: SessionReceivedMessages,
    sessionId: string,
    messageId: string,
    updatedAt: number,
): void {
    if (!Number.isFinite(updatedAt)) return;

    const messages = getOrCreateSessionReceivedMessages(sessionReceivedMessages, sessionId);
    const existingUpdatedAt = messages.get(messageId);
    if (existingUpdatedAt === undefined || updatedAt > existingUpdatedAt) {
        messages.set(messageId, updatedAt);
    }
}
