import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';

/** WebSocket framing over a supervised process's private binary stdio. */
export function attachWebSocketFrameReader(params: Readonly<{
    stdout: NodeJS.ReadableStream;
    write: (input: Uint8Array) => Promise<void>;
    onFrame: (frame: string) => void;
    onError: (error: Error) => void;
}>) {
    const stream = new Duplex({
        read() { params.stdout.resume(); },
        write(chunk: Buffer, _encoding, callback) {
            void params.write(chunk).then(() => callback(), error => callback(error instanceof Error ? error : new Error('WebSocket process write failed')));
        },
    });
    const onData = (chunk: Buffer) => { if (!stream.push(chunk)) params.stdout.pause(); };
    const onEnd = () => { stream.push(null); };
    const onError = (error: Error) => { stream.destroy(error); };
    params.stdout.on('data', onData);
    params.stdout.once('end', onEnd);
    params.stdout.once('error', onError);
    const socket = new WebSocket('ws://localhost/', {
        // ws and Node's HTTP agent accept a Duplex; @types/ws narrows this external boundary to Socket.
        createConnection: () => stream as Socket,
        perMessageDeflate: false,
        // Keep ws's existing transport allocation ceiling. Below that boundary,
        // the JSON-RPC owner rejects oversized responses by correlation.
    });
    let disposed = false;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
        rejectReady = reject;
        socket.once('open', () => resolve());
    });
    // Connection failure may precede the first protocol write.
    void ready.catch(() => undefined);
    socket.on('message', frame => params.onFrame(frame.toString()));
    socket.on('error', error => {
        rejectReady(error);
        if (!disposed) params.onError(error);
    });
    socket.on('close', () => {
        const error = new Error('WebSocket process transport closed');
        rejectReady(error);
        if (!disposed) params.onError(error);
    });
    return {
        async write(frame: string): Promise<void> {
            await ready;
            await new Promise<void>((resolve, reject) => {
                socket.send(frame, { binary: false }, error => error ? reject(error) : resolve());
            });
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            rejectReady(new Error('WebSocket process transport disposed'));
            params.stdout.removeListener('data', onData);
            params.stdout.removeListener('end', onEnd);
            params.stdout.removeListener('error', onError);
            socket.terminate();
            stream.destroy();
        },
    };
}
