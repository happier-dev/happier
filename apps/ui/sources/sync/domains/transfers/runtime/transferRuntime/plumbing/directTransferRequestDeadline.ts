const DEFAULT_DIRECT_TRANSFER_REQUEST_TIMEOUT_MS = 5_000;

function parseOptionalPositiveInt(value: unknown): number | null {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return null;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return Math.floor(parsed);
}

export function resolveDirectTransferRequestTimeoutMs(timeoutMs: number | null | undefined): number {
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        return Math.floor(timeoutMs);
    }

    return (
        parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS)
        ?? DEFAULT_DIRECT_TRANSFER_REQUEST_TIMEOUT_MS
    );
}

export function createDirectTransferRequestAbortSignal(params: Readonly<{
    timeoutMs: number;
    signal?: AbortSignal | null;
}>): Readonly<{
    signal: AbortSignal;
    cleanup: () => void;
}> {
    const controller = new AbortController();
    const abortFromParent = () => {
        controller.abort(params.signal?.reason);
    };

    if (params.signal) {
        if (params.signal.aborted) {
            controller.abort(params.signal.reason);
        } else {
            params.signal.addEventListener('abort', abortFromParent, { once: true });
        }
    }

    const timeoutId = setTimeout(() => {
        controller.abort(new Error('Direct transfer request timed out'));
    }, params.timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutId);
            params.signal?.removeEventListener('abort', abortFromParent);
        },
    };
}
