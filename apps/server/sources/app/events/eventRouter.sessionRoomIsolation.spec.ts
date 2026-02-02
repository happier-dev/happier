import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect as netConnect } from "node:net";
import { Server } from "socket.io";

import { eventRouter } from "./eventRouter";
import { getSocketRooms } from "@/app/api/socketRooms";

const require = createRequire(import.meta.url);
const { io: ioClient } = require("socket.io-client") as typeof import("socket.io-client");

async function startTestIoServer() {
    const httpServer = createServer();
    const seenRequests: string[] = [];
    const seenUpgrades: string[] = [];
    httpServer.on("request", (req) => {
        if (req.url) seenRequests.push(req.url);
    });
    httpServer.on("upgrade", (req) => {
        if (req.url) seenUpgrades.push(req.url);
    });
    const io = new Server(httpServer, {
        path: "/v1/updates",
        serveClient: false,
    });

    io.on("connection", (socket) => {
        const userId = socket.handshake.auth.userId as string | undefined;
        if (!userId) {
            socket.disconnect();
            return;
        }

        const clientType = socket.handshake.auth.clientType as any;
        const sessionId = socket.handshake.auth.sessionId as string | undefined;
        const machineId = socket.handshake.auth.machineId as string | undefined;

        socket.join(getSocketRooms({ userId, clientType, sessionId, machineId }));
    });

    await new Promise<void>((resolve) => {
        httpServer.listen(0, () => resolve());
    });

    const address = httpServer.address();
    if (!address || typeof address === "string") {
        throw new Error("Failed to bind test server");
    }

    const url = `http://localhost:${address.port}`;

    // Sanity-check that the server port is reachable before Socket.IO attempts to connect.
    await new Promise<void>((resolve, reject) => {
        const s = netConnect(address.port, "127.0.0.1");
        s.once("connect", () => {
            s.end();
            resolve();
        });
        s.once("error", reject);
    });

    return {
        url,
        io,
        seenRequests,
        seenUpgrades,
        close: async () => {
            // Socket.IO closes the underlying HTTP server when constructed with an httpServer instance.
            await io.close();
        },
    };
}

function connectClient(params: { url: string; userId: string; clientType: "session-scoped" | "user-scoped"; sessionId?: string }) {
    const socket = ioClient(params.url, {
        path: "/v1/updates",
        auth: {
            userId: params.userId,
            clientType: params.clientType,
            ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        },
        reconnection: false,
        autoConnect: true,
    });

    return socket;
}

async function waitForConnect(socket: any) {
    if (socket.connected) return;
    await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onError = (err: any) => {
            cleanup();
            reject(new Error(err?.message || String(err)));
        };
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("connect_error", onError);
        };
        socket.on("connect", onConnect);
        socket.on("connect_error", onError);
    });
}

describe("eventRouter session room isolation (integration)", () => {
    afterEach(() => {
        eventRouter.clearIo();
    });

    it("does not leak recipient-specific updates across users who share a sessionId", async () => {
        const server = await startTestIoServer();
        eventRouter.setIo(server.io as any);

        const u1 = connectClient({ url: server.url, userId: "u1", clientType: "session-scoped", sessionId: "s1" });
        const u2 = connectClient({ url: server.url, userId: "u2", clientType: "session-scoped", sessionId: "s1" });

        try {
            try {
                await Promise.all([waitForConnect(u1), waitForConnect(u2)]);
            } catch (err) {
                throw new Error(
                    `Socket connect failed: ${(err as any)?.message || String(err)} (requests=${server.seenRequests.length}, upgrades=${server.seenUpgrades.length})`
                );
            }

            const receivedByU1: any[] = [];
            const receivedByU2: any[] = [];

            u1.on("update", (data) => receivedByU1.push(data));
            u2.on("update", (data) => receivedByU2.push(data));

            eventRouter.emitUpdate({
                userId: "u1",
                payload: {
                    id: "upd-1",
                    seq: 10,
                    createdAt: Date.now(),
                    body: {
                        // This update type can include secrets (token), so it must never fan out to other users.
                        t: "public-share-created",
                        sessionId: "s1",
                        publicShareId: "ps1",
                        token: "tok",
                        expiresAt: null,
                        maxUses: null,
                        isConsentRequired: false,
                        updatedAt: Date.now(),
                    },
                } as any,
                recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
            });

            // Give the event loop a moment for delivery.
            await new Promise((r) => setTimeout(r, 50));

            expect(receivedByU1.length).toBe(1);
            expect(receivedByU2.length).toBe(0);

            // Prove that two recipients can legitimately have different cursors, and they must not receive each other's containers.
            eventRouter.emitUpdate({
                userId: "u2",
                payload: { id: "upd-2", seq: 20, createdAt: Date.now(), body: { t: "new-message", sid: "s1", msg: {} } } as any,
                recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
            });

            await new Promise((r) => setTimeout(r, 50));

            expect(receivedByU1.length).toBe(1);
            expect(receivedByU2.length).toBe(1);
        } finally {
            u1.disconnect();
            u2.disconnect();
            await server.close();
        }
    });
});
