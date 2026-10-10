import type { Server } from 'socket.io';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { SocketRoomEmitter } from '@/app/events/socketRoomEmitter';
import { log } from '@/utils/logging/log';

/** Cancels only the exact Socket-RPC target and server-minted request correlation. */
export function cancelRpcTarget(input: Readonly<{
    io: SocketRoomEmitter;
    targetSocketId: string;
    targetRequestId: string;
}>): void {
    try {
        // The network adapter's domain-facing room type lists fanout events; Socket.IO also owns RPC cancellation.
        const room = input.io.to(input.targetSocketId) as unknown as Pick<ReturnType<Server['to']>, 'emit'>;
        room.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId: input.targetRequestId });
    } catch (error) {
        log({ module: 'websocket-rpc', level: 'warn', targetSocketId: input.targetSocketId },
            `RPC target cancellation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
