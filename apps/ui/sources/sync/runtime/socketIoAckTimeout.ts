export function isSocketIoAckTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.message === 'operation has timed out';
}
