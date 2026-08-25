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
    // `emitWithAck` must be invoked ON its socket. In socket.io-client it is a prototype method
    // whose body is `this.emit(ev, ...args)`, and `timeout(ms)` returns the socket itself — so
    // reading `.emitWithAck` off it and calling the bare reference detaches the receiver and the
    // library throws `Cannot read properties of undefined (reading 'emit')` from inside its own
    // Promise executor. That surfaced as an internal TypeError in user-facing error slots
    // (`F-UI-2`). Keep the receiver and call through it.
    const ackScope = params.timeoutMs === null
        ? params.socket
        : params.socket.timeout(params.timeoutMs);
    const emitWithAck = ackScope.emitWithAck;
    if (!emitWithAck) {
        throw new Error('Scoped RPC socket does not support unbounded acknowledgements');
    }
    return await issueSocketRpcCallWithCancellation({
        signal: params.signal,
        requestId: params.requestId,
        onIssued: params.onIssued,
        issue: async () => await raceSocketIoAckTimeout(
            emitWithAck.call(ackScope, params.event, params.payload),
            params.timeoutMs ?? undefined,
        ) as TAck,
        emitCancel: (requestId) => {
            params.socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId });
        },
    });
}
