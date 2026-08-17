/**
 * One local owner for the cancellation lifetime of a Socket RPC call. The
 * server remains the authority for routing cancellation to an exact target;
 * this only stops waiting locally and emits the additive relay request once a
 * call was actually issued.
 */

export function createSocketRpcRequestId(): string {
    const cryptoAny = globalThis.crypto as { randomUUID?: () => string } | undefined;
    const raw = typeof cryptoAny?.randomUUID === 'function'
        ? cryptoAny.randomUUID()
        : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    return `rpc_${raw}`;
}

export function createSocketRpcAbortError(): Error {
    const error = new Error('Socket RPC was aborted by the caller');
    error.name = 'AbortError';
    Object.assign(error, { code: 'SOCKET_RPC_ABORTED' });
    return error;
}

export function issueSocketRpcCallWithCancellation<T>(params: Readonly<{
    signal?: AbortSignal;
    requestId?: string;
    onIssued?: () => void;
    issue: () => Promise<T>;
    emitCancel?: (requestId: string) => void;
}>): Promise<T> {
    if (params.signal?.aborted) {
        return Promise.reject(createSocketRpcAbortError());
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let issued = false;

        const cleanup = () => {
            params.signal?.removeEventListener('abort', onAbort);
        };
        const resolveOnce = (value: T) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onAbort = () => {
            if (settled) return;
            if (issued && params.requestId) {
                try {
                    params.emitCancel?.(params.requestId);
                } catch {
                    // Cancellation is additive: a legacy or disconnected relay
                    // still leaves the caller with its local stale-result fence.
                }
            }
            rejectOnce(createSocketRpcAbortError());
        };

        params.signal?.addEventListener('abort', onAbort, { once: true });
        if (params.signal?.aborted) {
            onAbort();
            return;
        }

        try {
            params.onIssued?.();
            if (params.signal?.aborted) {
                onAbort();
                return;
            }
            issued = true;
            params.issue().then(resolveOnce, rejectOnce);
        } catch (error) {
            rejectOnce(error);
        }
    });
}
