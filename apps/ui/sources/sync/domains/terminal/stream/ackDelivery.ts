import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import type { TerminalRendererAck } from './model';

const TERMINAL_RENDERER_ACK_RETRY_BASE_DELAY_MS = 250;
const TERMINAL_RENDERER_ACK_RETRY_MAX_DELAY_MS = 1_000;
export const TERMINAL_RENDERER_ACK_MAX_RETRY_ATTEMPTS = 3;

export type TerminalRendererAckDeliveryDiagnostic =
    | Readonly<{
        kind: 'retry-scheduled';
        errorCode: string;
        retryAttempt: number;
    }>
    | Readonly<{
        kind: 'delivery-suppressed';
        errorCode: string;
    }>
    | Readonly<{
        kind: 'delivery-abandoned';
        errorCode: string;
        retryAttempts: number;
    }>;

export type TerminalRendererAckDelivery = Readonly<{
    enqueue: (ack: TerminalRendererAck) => void;
    dispose: () => void;
}>;

type TerminalRendererAckDeliveryOptions = Readonly<{
    send: (ack: TerminalRendererAck) => Promise<void>;
    onDiagnostic?: (diagnostic: TerminalRendererAckDeliveryDiagnostic) => void;
}>;

const OBSOLETE_ACK_ERROR_CODES = new Set<string>([
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
    'terminal_not_found',
    'terminal_byte_stream_disabled',
    'terminal_byte_stream_unavailable',
]);

function readAckErrorCode(error: unknown): string {
    const rpcErrorCode = readRpcErrorCode(error);
    if (typeof rpcErrorCode === 'string' && rpcErrorCode.trim()) {
        return rpcErrorCode.trim();
    }
    if (error && typeof error === 'object') {
        const carrier = error as Readonly<{ code?: unknown; errorCode?: unknown }>;
        if (typeof carrier.code === 'string' && carrier.code.trim()) {
            return carrier.code.trim();
        }
        if (typeof carrier.errorCode === 'string' && carrier.errorCode.trim()) {
            return carrier.errorCode.trim();
        }
    }
    return 'terminal_ack_delivery_failed';
}

function resolveRetryDelayMs(retryAttempt: number): number {
    return Math.min(
        TERMINAL_RENDERER_ACK_RETRY_MAX_DELAY_MS,
        TERMINAL_RENDERER_ACK_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryAttempt - 1)),
    );
}

function isSameAckIdentity(left: TerminalRendererAck, right: TerminalRendererAck): boolean {
    return left.terminalId === right.terminalId
        && left.rendererId === right.rendererId
        && left.surfaceEpoch === right.surfaceEpoch;
}

function coalesceAck(
    existing: TerminalRendererAck | null,
    incoming: TerminalRendererAck,
): TerminalRendererAck {
    if (!existing || !isSameAckIdentity(existing, incoming)) {
        return incoming;
    }
    return incoming.ackedByteOffset >= existing.ackedByteOffset ? incoming : existing;
}

export function createTerminalRendererAckDelivery(
    options: TerminalRendererAckDeliveryOptions,
): TerminalRendererAckDelivery {
    let pendingAck: TerminalRendererAck | null = null;
    let inFlight = false;
    let retryAttempts = 0;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let suppressed = false;

    const emitDiagnostic = (diagnostic: TerminalRendererAckDeliveryDiagnostic) => {
        try {
            options.onDiagnostic?.(diagnostic);
        } catch {
            // Diagnostics must never affect terminal stream delivery.
        }
    };

    const pump = async (): Promise<void> => {
        if (disposed || suppressed || inFlight || retryTimeout !== null || !pendingAck) {
            return;
        }

        const sentAck = pendingAck;
        pendingAck = null;
        inFlight = true;
        try {
            await options.send(sentAck);
            retryAttempts = 0;
        } catch (error) {
            if (disposed) {
                return;
            }
            const errorCode = readAckErrorCode(error);
            if (OBSOLETE_ACK_ERROR_CODES.has(errorCode)) {
                suppressed = true;
                pendingAck = null;
                emitDiagnostic({ kind: 'delivery-suppressed', errorCode });
                return;
            }

            pendingAck = coalesceAck(sentAck, pendingAck ?? sentAck);
            if (retryAttempts >= TERMINAL_RENDERER_ACK_MAX_RETRY_ATTEMPTS) {
                pendingAck = null;
                suppressed = true;
                emitDiagnostic({
                    kind: 'delivery-abandoned',
                    errorCode,
                    retryAttempts,
                });
                return;
            }

            retryAttempts += 1;
            emitDiagnostic({ kind: 'retry-scheduled', errorCode, retryAttempt: retryAttempts });
            retryTimeout = setTimeout(() => {
                retryTimeout = null;
                void pump();
            }, resolveRetryDelayMs(retryAttempts));
        } finally {
            inFlight = false;
            if (!retryTimeout) {
                void pump();
            }
        }
    };

    return {
        enqueue: (ack) => {
            if (disposed || suppressed) {
                return;
            }
            pendingAck = coalesceAck(pendingAck, ack);
            void pump();
        },
        dispose: () => {
            disposed = true;
            pendingAck = null;
            if (retryTimeout !== null) {
                clearTimeout(retryTimeout);
                retryTimeout = null;
            }
        },
    };
}
