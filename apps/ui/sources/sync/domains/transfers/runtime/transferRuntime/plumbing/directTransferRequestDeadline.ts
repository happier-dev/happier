import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import type { MachineCarrierHttpLease } from './machineCarrierHttpLease';

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

/** Home phases already have the Machine RPC budget; HTTP must not shorten it. */
export function resolveMachineCarrierRequestTimeoutMs(
    timeoutMs: number | null | undefined,
    carrierKind?: MachineCarrierHttpLease['kind'],
): number | null {
    return carrierKind === 'server_rpc' && timeoutMs == null
        ? null : resolveDirectTransferRequestTimeoutMs(timeoutMs);
}

export function createDirectTransferRequestAbortSignal(params: Readonly<{
    timeoutMs: number | null;
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

    const timeoutId = params.timeoutMs === null ? null : setTimeout(() => {
        // The Machine did not answer in time: the same typed timeout every Machine request carries, so a caller words it
        // as "isn't answering" instead of the transport's own text.
        controller.abort(Object.assign(new Error('Direct transfer request timed out'),
            { code: MACHINE_RPC_TIMEOUT_ERROR_CODE, errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE }));
    }, params.timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            if (timeoutId !== null) clearTimeout(timeoutId);
            params.signal?.removeEventListener('abort', abortFromParent);
        },
    };
}
