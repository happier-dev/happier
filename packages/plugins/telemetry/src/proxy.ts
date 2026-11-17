import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { PostgresWireTracker, type WireCoverage, type WireObservation } from './wire/tracker.js';

export type PostgresProxyOptions = {
    listenHost: '127.0.0.1' | '::1'; listenPort: number; upstream: { host: string; port: number };
    onObservation: (observation: WireObservation) => void; onCoverage?: (coverage: WireCoverage) => void;
};
export type PostgresProxy = { host: '127.0.0.1' | '::1'; port: number; setRecording(enabled: boolean): void; stop(): Promise<void> };

export async function startPostgresProxy(options: PostgresProxyOptions): Promise<PostgresProxy> {
    let recording = true;
    const sockets = new Set<Socket>();
    const trackers = new Set<PostgresWireTracker>();
    const server = createServer({ allowHalfOpen: true }, client => {
        const upstream = createConnection({ ...options.upstream, allowHalfOpen: true });
        sockets.add(client); sockets.add(upstream);
        const tracker = recording ? new PostgresWireTracker({ connectionId: randomUUID(), onObservation: options.onObservation, onCoverage: options.onCoverage }) : undefined;
        if (tracker) trackers.add(tracker);
        upstream.pipe(client);
        upstream.on('data', bytes => tracker?.backend(bytes));
        // Only the optional SSL probe terminates here. Auth and subsequent frames remain byte-transparent.
        const header = Buffer.alloc(8);
        let headerBytes = 0;
        const beginForwarding = (bytes: Buffer) => {
            client.removeListener('data', negotiate);
            client.pipe(upstream);
            client.on('data', chunk => tracker?.frontend(chunk));
            upstream.write(bytes);
            tracker?.frontend(bytes);
        };
        const negotiate = (bytes: Buffer) => {
            let offset = 0;
            while (offset < bytes.length) {
                const count = Math.min(8 - headerBytes, bytes.length - offset);
                bytes.copy(header, headerBytes, offset, offset + count); headerBytes += count; offset += count;
                if (headerBytes < 8) return;
                if (header.readInt32BE(0) === 8 && header.readInt32BE(4) === 80877103) {
                    client.write('N'); headerBytes = 0;
                } else {
                    beginForwarding(Buffer.concat([header, bytes.subarray(offset)])); return;
                }
            }
        };
        client.on('data', negotiate);
        const close = () => { client.destroy(); upstream.destroy(); tracker?.close(); if (tracker) trackers.delete(tracker); sockets.delete(client); sockets.delete(upstream); };
        client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.listenPort, options.listenHost, () => { server.removeListener('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback proxy has no TCP address');
    let stopped: Promise<void> | undefined;
    return {
        host: options.listenHost, port: address.port,
        setRecording(enabled: boolean): void { recording = enabled; if (!enabled) for (const tracker of trackers) tracker.close(); },
        stop(): Promise<void> {
            stopped ??= new Promise<void>(resolve => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); });
            return stopped;
        },
    };
}
