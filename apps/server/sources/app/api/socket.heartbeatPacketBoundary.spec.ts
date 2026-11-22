import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { Server } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveSocketRpcHeartbeatPacketMaxBytes } from '@happier-dev/protocol/socketRpc';

// The relay drops a client whose pong is late, and a pong queued behind a packet the client is still
// uploading arrives only after that upload. This exercises real Engine.IO heartbeats over a
// throttled client → server link, with timings scaled down from the production values.
const PING_INTERVAL_MS = 400;
const PING_TIMEOUT_MS = 1_200;
const UPLINK_BYTES_PER_SECOND = 400_000;
const TICK_MS = 20;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
});

async function listen(server: net.Server | http.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
}

/** TCP proxy that paces client → server bytes at UPLINK_BYTES_PER_SECOND; the other direction is unpaced. */
async function startThrottledUplinkProxy(targetPort: number): Promise<number> {
    const proxy = net.createServer((client) => {
        const upstream = net.connect(targetPort, '127.0.0.1');
        upstream.pipe(client);
        const queue: Buffer[] = [];
        let timer: NodeJS.Timeout | null = null;
        const pump = () => {
            let budget = Math.floor((UPLINK_BYTES_PER_SECOND * TICK_MS) / 1_000);
            while (budget > 0 && queue.length > 0) {
                const head = queue[0]!;
                if (head.length <= budget) {
                    upstream.write(head);
                    budget -= head.length;
                    queue.shift();
                } else {
                    upstream.write(head.subarray(0, budget));
                    queue[0] = head.subarray(budget);
                    budget = 0;
                }
            }
            timer = queue.length > 0 ? setTimeout(pump, TICK_MS) : null;
        };
        client.on('data', (chunk) => {
            queue.push(chunk);
            if (!timer) pump();
        });
        const destroy = () => {
            if (timer) clearTimeout(timer);
            client.destroy();
            upstream.destroy();
        };
        client.on('close', destroy);
        upstream.on('close', destroy);
        client.on('error', () => {});
        upstream.on('error', () => {});
    });
    closers.push(() => new Promise((resolve) => proxy.close(() => resolve())));
    return await listen(proxy);
}

async function uploadOnePacket(bytes: number): Promise<{ delivered: boolean; serverCloseReason: string | null }> {
    const httpServer = http.createServer();
    const io = new Server(httpServer, {
        pingInterval: PING_INTERVAL_MS,
        pingTimeout: PING_TIMEOUT_MS,
        maxHttpBufferSize: 25_000_000,
        transports: ['websocket'],
    });
    closers.push(() => new Promise((resolve) => io.close(() => resolve())));
    let serverCloseReason: string | null = null;
    let delivered = false;
    io.on('connection', (socket) => {
        socket.on('disconnect', (reason) => {
            serverCloseReason = reason;
        });
        socket.on('reply', () => {
            delivered = true;
        });
    });
    const proxyPort = await startThrottledUplinkProxy(await listen(httpServer));

    const client: ClientSocket = connectClient(`http://127.0.0.1:${proxyPort}`, { transports: ['websocket'], reconnection: false });
    closers.push(async () => {
        client.close();
    });
    await new Promise<void>((resolve) => client.on('connect', () => resolve()));
    // Let the first heartbeat cycle start so the upload overlaps a pending pong deadline.
    await new Promise((resolve) => setTimeout(resolve, PING_INTERVAL_MS + 50));

    client.emit('reply', 'x'.repeat(bytes));
    const uploadMs = (bytes / UPLINK_BYTES_PER_SECOND) * 1_000;
    const deadline = Date.now() + uploadMs + PING_INTERVAL_MS + PING_TIMEOUT_MS * 2;
    while (!delivered && serverCloseReason === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    }
    return { delivered, serverCloseReason };
}

describe('relay heartbeat packet boundary', () => {
    const boundaryBytes = resolveSocketRpcHeartbeatPacketMaxBytes({
        pingTimeoutMs: PING_TIMEOUT_MS,
        uplinkBytesPerSecond: UPLINK_BYTES_PER_SECOND,
    });

    it('delivers a packet that uploads well inside the pong deadline', async () => {
        const result = await uploadOnePacket(Math.floor(boundaryBytes * 0.6));

        expect(result).toEqual({ delivered: true, serverCloseReason: null });
    }, 20_000);

    it('closes the socket for a packet whose upload outlasts the pong deadline, far below maxHttpBufferSize', async () => {
        const result = await uploadOnePacket(Math.floor(boundaryBytes * 1.6));

        expect(result).toEqual({ delivered: false, serverCloseReason: 'ping timeout' });
    }, 20_000);
});
