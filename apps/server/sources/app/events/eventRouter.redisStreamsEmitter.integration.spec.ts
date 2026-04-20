import { createServer } from "node:http";

import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";

import { resolveRedisAdapterValidationRedisUrl } from "../../../scripts/resolveRedisAdapterValidationRedisUrl";
import { getSocketRooms } from "@/app/api/socketRooms";

import { RedisStreamsRoomEmitter } from "./createRedisStreamsRoomEmitter";
import { eventRouter } from "./eventRouter";

const SOCKET_PATH = "/v1/updates";

type RedisMemoryInstance = Awaited<ReturnType<typeof resolveRedisAdapterValidationRedisUrl>>["redisMemory"];

type StartedCluster = Readonly<{
    ioA: Server;
    ioB: Server;
    emitter: RedisStreamsRoomEmitter;
    redisA: Redis;
    redisB: Redis;
    redisEmitter: Redis;
    redisMemory: RedisMemoryInstance;
    portA: number;
    portB: number;
    close: () => Promise<void>;
}>;

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address && typeof address === "object") {
        return address.port;
    }
    throw new Error("Failed to determine server port");
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startCluster(): Promise<StartedCluster> {
    const { redisUrl, redisMemory } = await resolveRedisAdapterValidationRedisUrl({
        env: process.env,
    });

    const redisA = new Redis(redisUrl);
    const redisB = new Redis(redisUrl);
    const redisEmitter = new Redis(redisUrl);
    const httpA = createServer();
    const httpB = createServer();
    const ioA = new Server(httpA, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisA),
    });
    const ioB = new Server(httpB, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisB),
    });

    const attachConnectionHandler = (io: Server) => {
        io.on("connection", (socket) => {
            const userId = socket.handshake.auth.userId as string | undefined;
            const clientType = socket.handshake.auth.clientType as "user-scoped" | undefined;
            if (!userId || !clientType) {
                socket.disconnect();
                return;
            }

            socket.join(getSocketRooms({
                userId,
                clientType,
            }));
        });
    };

    attachConnectionHandler(ioA);
    attachConnectionHandler(ioB);

    const portA = await listen(httpA);
    const portB = await listen(httpB);

    return {
        ioA,
        ioB,
        emitter: new RedisStreamsRoomEmitter(redisEmitter, { maxLen: 2_000 }),
        redisA,
        redisB,
        redisEmitter,
        redisMemory,
        portA,
        portB,
        close: async () => {
            await ioA.close();
            await ioB.close();
            await closeServer(httpA);
            await closeServer(httpB);
            await redisA.quit();
            await redisB.quit();
            await redisEmitter.quit();
            if (redisMemory) {
                await redisMemory.stop();
            }
        },
    };
}

async function connectClient(port: number): Promise<ClientSocket> {
    const socket = createClient(`http://127.0.0.1:${port}`, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        timeout: 5_000,
        auth: {
            userId: "user-1",
            clientType: "user-scoped",
        },
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout connecting socket client on port ${port}`)), 6_000);
        socket.once("connect", () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once("connect_error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });

    return socket;
}

describe("eventRouter redis streams emitter integration", () => {
    const startedClusters: StartedCluster[] = [];
    const startedClients: ClientSocket[] = [];

    afterEach(async () => {
        eventRouter.clearIo();
        while (startedClients.length > 0) {
            startedClients.pop()?.disconnect();
        }
        while (startedClusters.length > 0) {
            await startedClusters.pop()?.close();
        }
    });

    it("delivers room-targeted updates from an external emitter process to connected api sockets", async () => {
        const cluster = await startCluster();
        startedClusters.push(cluster);
        const socket = await connectClient(cluster.portB);
        startedClients.push(socket);

        eventRouter.setIo(cluster.emitter as unknown as Parameters<typeof eventRouter.setIo>[0]);

        const updatePromise = new Promise<unknown>((resolve) => {
            socket.once("update", (payload) => resolve(payload));
        });

        eventRouter.emitUpdate({
            userId: "user-1",
            payload: {
                id: "upd-1",
                seq: 1,
                createdAt: Date.now(),
                body: { t: "new-message" },
            } as never,
            recipientFilter: { type: "all-user-authenticated-connections" },
        });

        await expect(updatePromise).resolves.toEqual(expect.objectContaining({
            id: "upd-1",
        }));
    });
});
