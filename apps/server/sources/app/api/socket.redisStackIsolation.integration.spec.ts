import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startRedisAdapterRecoveryCluster, holdRedisAdapterDiscoveryRequests } from "@/testkit/redisAdapterRecoveryCluster";
import { readSocketRoomSnapshot } from "./socket/socketRoomDiscovery";
import { resolveRedisAdapterValidationRedisUrl } from "../../../scripts/resolveRedisAdapterValidationRedisUrl";

type ProductCluster = Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>>;

describe("per-stack Redis adapter isolation", () => {
    let redisUrl: string;
    let redisMemory: Awaited<ReturnType<typeof resolveRedisAdapterValidationRedisUrl>>["redisMemory"];
    const openClusters: ProductCluster[] = [];
    const openClients: ClientSocket[] = [];

    beforeAll(async () => {
        // Ignore ambient infrastructure: this suite owns its disposable Redis.
        const resolved = await resolveRedisAdapterValidationRedisUrl({ env: {} });
        redisUrl = resolved.redisUrl;
        redisMemory = resolved.redisMemory;
        if (!redisMemory) throw new Error("Stack isolation proof requires an embedded Redis instance");
    });

    afterAll(async () => {
        while (openClients.length > 0) openClients.pop()?.disconnect();
        while (openClusters.length > 0) await openClusters.pop()?.close();
        await redisMemory?.stop();
    });

    async function connect(port: number): Promise<ClientSocket> {
        const socket = createClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates", transports: ["websocket"],
        });
        openClients.push(socket);
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("connect_error", reject);
        });
        return socket;
    }

    it('excludes a different stack from census and stream fanout on the same Redis instance', async () => {
        const dev = await startRedisAdapterRecoveryCluster({ redisUrl, adapterScope: 'hstack:repo-dev-test' });
        openClusters.push(dev);
        const qa = await startRedisAdapterRecoveryCluster({ redisUrl, adapterScope: 'hstack:agent-qa-test' });
        openClusters.push(qa);
        const [caller, target] = dev.nodes;
        const [foreign] = qa.nodes;
        const room = 'rpc:stack-isolation';
        for (const node of [...dev.nodes, ...qa.nodes]) {
            node.io.on('connection', socket => { void socket.join(room); });
        }
        const localClient = await connect(target.port);
        const foreignClient = await connect(foreign.port);
        const held = holdRedisAdapterDiscoveryRequests(foreign.io);
        try {
            expect(await caller.io.of('/').adapter.serverCount()).toBe(2);
            expect(await foreign.io.of('/').adapter.serverCount()).toBe(2);
            const snapshot = await readSocketRoomSnapshot({ io: caller.io, room, timeoutMs: 1_000 });
            expect(snapshot.complete).toBe(true);
            expect(snapshot.sockets.map(socket => 'id' in socket ? socket.id : undefined)).toEqual([localClient.id]);
            expect(held.count).toBe(0);
            // ACK broadcasts use Pub/Sub in adapter 0.3.1.
            localClient.on('stack-scope-probe', (reply: (value: string) => void) => reply('dev'));
            foreignClient.on('stack-scope-probe', (reply: (value: string) => void) => reply('qa'));
            expect(await caller.io.to(room).timeout(1_000).emitWithAck('stack-scope-probe')).toEqual(['dev']);
            const leaked: unknown[] = [];
            foreignClient.on('stack-stream-probe', value => leaked.push(value));
            const delivered = new Promise(resolve => localClient.once('stack-stream-probe', resolve));
            caller.io.to(room).emit('stack-stream-probe', 'dev');
            expect(await delivered).toBe('dev');
            // A remote QA-stream delivery proves its reader passed any earlier
            // dev entry if the stream names were accidentally still shared.
            const fence = new Promise<void>(resolve => foreignClient.once('stack-stream-fence', () => resolve()));
            qa.nodes[1].io.to(room).emit('stack-stream-fence');
            await fence;
            expect(leaked).toEqual([]);
        } finally {
            held.release();
        }
    });

});
