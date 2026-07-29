export function classifyServerRelayTransferChunkSequence(
    receivedSequence: number,
    nextExpectedSequence: number,
): 'duplicate' | 'next' {
    if (receivedSequence < nextExpectedSequence) {
        return 'duplicate';
    }
    if (receivedSequence > nextExpectedSequence) {
        throw new Error(
            `Server relay transfer received out-of-order chunk ${receivedSequence}; expected ${nextExpectedSequence}`,
        );
    }
    return 'next';
}
