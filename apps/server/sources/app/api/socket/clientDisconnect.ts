import type { Server } from 'socket.io';

/** Retire the sole /v1/updates namespace's transport when its client leaves. */
export function registerClientDisconnectCleanup(io: Server): void {
    io.on('connection', socket => {
        socket.once('disconnect', reason => {
            if (reason !== 'client namespace disconnect') return;
            const transport = socket.conn.transport;
            // A namespace disconnect alone leaves Engine.IO open. Discard its
            // queue through its lifecycle owner rather than editing writeBuffer.
            socket.conn.close(true);
            if (transport.name === 'websocket') {
                // Engine.IO 6.6.11's ws transport keeps this runtime property
                // private in its declarations. ws.close() drains pending writes;
                // terminate() drops them after the peer has already left.
                const websocket = (transport as unknown as { socket: { terminate(): void } }).socket;
                websocket.terminate();
            }
        });
    });
}
