import http from "node:http";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Server } from "socket.io";
import { vi } from "vitest";
import { ClusterAdapter, MessageType, type ClusterMessage } from 'socket.io-adapter';
import { readRedisStreamsAdapterOptionsFromEnv } from "@/config/socketAdapter";
import { startSilentPartitionProxy } from "@/testkit/redisSilentPartitionProxy";
import { resolveRedisAdapterValidationRedisUrl } from "../../scripts/resolveRedisAdapterValidationRedisUrl";
import { registerSocketRoomDiscovery } from '@/app/api/socket/socketRoomDiscovery';

type ProductRedisOwner = typeof import("@/storage/redis/redis");
type RecoveryNode = {
    io: Server;
    redis: ReturnType<ProductRedisOwner["getRedisSocketClusterClient"]>;
    port: number;
    owner: ProductRedisOwner;
};

/** Hold a counted peer at the real native discovery transport, without stopping its Redis subscription. */
export function holdRedisAdapterDiscoveryRequests(io: Server) {
    const adapter = io.sockets.adapter;
    if (!(adapter instanceof ClusterAdapter)) throw new Error('Expected the real ClusterAdapter');
    // Protected upstream transport hook is the genuine external-system boundary.
    const receiver = adapter as unknown as { readonly uid: string; onMessage(message: ClusterMessage, offset?: string): void };
    const receive = receiver.onMessage.bind(receiver);
    const held: Array<readonly [ClusterMessage, string | undefined]> = [];
    let received!: () => void;
    const firstRequest = new Promise<void>(resolve => { received = resolve; });
    const spy = vi.spyOn(receiver, 'onMessage').mockImplementation((message, offset) => {
        // Pub/Sub echoes the sender's frames; ClusterAdapter ignores those itself.
        if (message.uid !== receiver.uid && (message.type === MessageType.FETCH_SOCKETS || message.type === MessageType.SERVER_SIDE_EMIT)) {
            held.push([message, offset]);
            received();
        } else receive(message, offset);
    });
    return {
        received: firstRequest,
        get count() { return held.length; },
        release() {
            spy.mockRestore();
            for (const [message, offset] of held.splice(0)) receive(message, offset);
        },
    };
}

export async function startRedisAdapterRecoveryCluster(options: { redisUrl?: string; nodeCount?: 2 | 3; adapterScope?: string } = {}) {
    // Recovery tests must never stop an ambient operator Redis instance.
    const { redisUrl, redisMemory } = await resolveRedisAdapterValidationRedisUrl({
        env: options.redisUrl ? { REDIS_URL: options.redisUrl } : {},
    });
    const proxy = await startSilentPartitionProxy(redisUrl);
    const nodes: RecoveryNode[] = [];
    const owners: ProductRedisOwner[] = [];
    const servers: Server[] = [];
    let closePromise: Promise<void> | undefined;
    const close = (afterSocketClose?: () => Promise<void>): Promise<void> => {
        closePromise ??= (async () => {
            proxy.heal();
            try {
                for (const io of servers) await io.close();
                await afterSocketClose?.();
            } finally {
                for (const owner of owners) owner.closeRedisSocketClusterClient();
                await proxy.close();
                await redisMemory?.stop();
            }
        })();
        return closePromise;
    };
    try {
        const nodeCount = options.nodeCount ?? 2;
        for (let index = 0; index < nodeCount; index++) {
            const previousUrl = process.env.REDIS_URL;
            let owner: typeof import("@/storage/redis/redis");
            let redis: ReturnType<typeof owner.getRedisSocketClusterClient>;
            let adapter: ReturnType<typeof owner.getRedisSocketClusterAdapterClient>;
            try {
                process.env.REDIS_URL = proxy.url;
                vi.resetModules();
                owner = await import("@/storage/redis/redis");
                owners.push(owner);
                redis = owner.getRedisSocketClusterClient();
                adapter = owner.getRedisSocketClusterAdapterClient();
            } finally {
                if (previousUrl === undefined) delete process.env.REDIS_URL;
                else process.env.REDIS_URL = previousUrl;
            }
            const httpServer = http.createServer();
            const io = new Server(httpServer, {
                path: "/v1/updates", transports: ["websocket"], serveClient: false,
                adapter: createAdapter(adapter, readRedisStreamsAdapterOptionsFromEnv({
                    HAPPIER_SOCKET_ADAPTER_SCOPE: options.adapterScope,
                })),
            });
            servers.push(io);
            registerSocketRoomDiscovery(io);
            await new Promise<void>((resolve, reject) => {
                httpServer.once("error", reject);
                httpServer.listen(0, "127.0.0.1", resolve);
            });
            const address = httpServer.address();
            if (!address || typeof address === "string") throw new Error("Missing server address");
            nodes.push({ io, redis, port: address.port, owner });
        }
        const waitForRecovery = async () => {
            await vi.waitFor(async () => {
                for (const node of nodes) {
                    if (node.redis.status !== "ready" || await node.io.of("/").adapter.serverCount() < nodeCount) {
                        throw new Error("Waiting for both adapter subscribers");
                    }
                }
            }, { timeout: 25_000, interval: 100 });
        };
        await waitForRecovery();
        const [nodeA, nodeB] = nodes;
        if (!nodeA || !nodeB) throw new Error("Recovery cluster requires two nodes");
        return {
            nodes: [nodeA, nodeB, ...nodes.slice(2)] as const,
            recover: async (failure: "restart" | "silent partition") => {
                if (failure === "restart") {
                    if (!redisMemory) throw new Error("Caller owns Redis restart");
                    await redisMemory.stop();
                    await vi.waitFor(() => {
                        if (nodes.some((node) => node.redis.status === "ready")) throw new Error("Redis has not disconnected");
                    });
                    await redisMemory.start();
                } else {
                    proxy.partition();
                    // A command on each root exercises its real 5-second silent-stall detector.
                    const probes = nodes.map((node) => node.redis.ping().catch(() => undefined));
                    await vi.waitFor(() => {
                        if (nodes.some((node) => node.redis.status === "ready")) throw new Error("Silent stall not detected");
                    }, { timeout: 12_000, interval: 100 });
                    proxy.heal();
                    await Promise.all(probes);
                }
                await waitForRecovery();
            },
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
