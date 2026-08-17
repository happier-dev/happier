import { raceSocketIoAckTimeout } from '@/sync/runtime/socketIoAckTimeout';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { issueSocketRpcCallWithCancellation } from '@/sync/runtime/socketRpcCallCancellation';

type ScopedAckSocket = Readonly<{
    emitWithAck?: (event: string, payload: unknown) => Promise<unknown>;
    timeout: (ms: number) => Readonly<{
        emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
    }>;
    emit: (event: string, payload: unknown) => void;
}>;

export async function scopedSocketEmitWithAck<TAck>(params: Readonly<{
    socket: ScopedAckSocket;
    event: string;
    payload: unknown;
    timeoutMs: number | null;
    onIssued?: () => void;
    signal?: AbortSignal;
    requestId?: string;
}>): Promise<TAck> {
    const emitWithAck = params.timeoutMs === null
        ? params.socket.emitWithAck
        : params.socket.timeout(params.timeoutMs).emitWithAck;
    if (!emitWithAck) {
        throw new Error('Scoped RPC socket does not support unbounded acknowledgements');
    }
    return await issueSocketRpcCallWithCancellation({
        signal: params.signal,
        requestId: params.requestId,
        onIssued: params.onIssued,
        issue: async () => await raceSocketIoAckTimeout(
            emitWithAck(params.event, params.payload),
            params.timeoutMs ?? undefined,
        ) as TAck,
        emitCancel: (requestId) => {
            params.socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId });
        },
    });
}
