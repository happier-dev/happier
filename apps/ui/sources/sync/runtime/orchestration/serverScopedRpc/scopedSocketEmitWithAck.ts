import { raceSocketIoAckTimeout } from '@/sync/runtime/socketIoAckTimeout';

type ScopedAckSocket = Readonly<{
    timeout: (ms: number) => Readonly<{
        emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
    }>;
}>;

export async function scopedSocketEmitWithAck<TAck>(params: Readonly<{
    socket: ScopedAckSocket;
    event: string;
    payload: unknown;
    timeoutMs: number;
    onIssued?: () => void;
}>): Promise<TAck> {
    const socketEmission = params.socket.timeout(params.timeoutMs);
    params.onIssued?.();
    return await raceSocketIoAckTimeout(
        socketEmission.emitWithAck(params.event, params.payload),
        params.timeoutMs,
    ) as TAck;
}
