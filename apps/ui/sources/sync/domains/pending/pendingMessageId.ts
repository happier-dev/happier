export function isValidPendingMessageId(pendingId: string): boolean {
    const normalized = pendingId.trim();
    return normalized.length > 0 && normalized !== '.' && normalized !== '..';
}

export function assertValidPendingMessageId(pendingId: string): void {
    if (!isValidPendingMessageId(pendingId)) throw new Error('Pending message ID is invalid');
}
