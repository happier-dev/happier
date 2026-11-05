import type { Socket } from 'socket.io';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { withWebLatencyProducerTrace } from '@/utils/webLatencyTrace';

/** Called only after connect admission has installed the socket's handlers. */
export function dispatchSocketPacket(socket: Pick<Socket, 'listenerCount'>, packet: unknown[], next: () => void): void {
    const method = packet[0];
    const acknowledge = packet[packet.length - 1];
    if (typeof method === 'string' && typeof acknowledge === 'function' && socket.listenerCount(method) === 0) {
        acknowledge({ ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, method });
        return;
    }
    if (process.env.HAPPIER_WEB_LATENCY_TRACE === '1' && typeof method === 'string' && socket.listenerCount(method) > 0) {
        // Socket.IO schedules the handler from next(); retain its producer root
        // through that continuation without recording packet contents.
        withWebLatencyProducerTrace(`producer.socket.${method}`, next);
    } else {
        next();
    }
}
