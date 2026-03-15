import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";

import type { Fastify as AppFastify } from "./types";
import { startSocket } from "./socket";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";

type ClientSocket = ReturnType<typeof ioClient>;

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

function withEnvPatch<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(patch)) {
        previous[key] = process.env[key];
        if (value === undefined) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    return fn().finally(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });
}

async function waitForConnect(socket: ClientSocket): Promise<void> {
    if (socket.connected) return;
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("connect_error", onError);
        };
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onError = (err: unknown) => {
            cleanup();
            const msg = typeof err === "object" && err ? (err as any).message : String(err);
            reject(new Error(msg));
        };
        socket.on("connect", onConnect);
        socket.on("connect_error", onError);
    });
}

async function waitForEphemeral(socket: ClientSocket, timeoutMs: number): Promise<any> {
    return await new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for ephemeral"));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(t);
            socket.off("ephemeral", onEphemeral);
        };
        const onEphemeral = (payload: any) => {
            cleanup();
            resolve(payload);
        };
        socket.on("ephemeral", onEphemeral);
    });
}

async function assertNoEphemeral(socket: ClientSocket, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
            cleanup();
            resolve();
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(t);
            socket.off("ephemeral", onEphemeral);
        };
        const onEphemeral = (payload: any) => {
            cleanup();
            reject(new Error(`Unexpected ephemeral: ${JSON.stringify(payload)}`));
        };
        socket.on("ephemeral", onEphemeral);
    });
}

async function startSocketServer(): Promise<{ app: AppFastify; url: string; close: () => Promise<void> }> {
    const app = Fastify({ logger: false }) as unknown as AppFastify;
    startSocket(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) {
        await app.close();
        throw new Error("Failed to bind socket server");
    }
    return {
        app,
        url: `http://127.0.0.1:${port}`,
        close: async () => {
            await app.close();
        },
    };
}

function connectSessionScopedSocket(params: { url: string; token: string; sessionId: string }): ClientSocket {
    return ioClient(params.url, {
        path: "/v1/updates",
        transports: ["websocket"],
        reconnection: false,
        auth: { token: params.token, clientType: "session-scoped", sessionId: params.sessionId },
    });
}

describe("socket transcript-draft (encryption mode enforcement)", () => {
    let harness: LightSqliteHarness;
    let server: { close: () => Promise<void>; url: string } | null = null;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-socket-transcript-draft-", initAuth: true });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        if (server) {
            await server.close();
            server = null;
        }
        await db.sessionMessage.deleteMany();
        await db.sessionShare.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    it("drops plaintext transcript-draft deltas for e2ee sessions", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}` }, select: { id: true } });
        const token = await auth.createToken(account.id);

        const sessionId = "s-e2ee";
        await db.session.create({
            data: { id: sessionId, tag: `t-${Date.now()}`, accountId: account.id, encryptionMode: "e2ee", metadata: "{}" },
        });

        server = await startSocketServer();
        const socket = connectSessionScopedSocket({ url: server.url, token, sessionId });
        try {
            await waitForConnect(socket);

            socket.emit("transcript-draft", {
                sid: sessionId,
                localId: "l1",
                segmentKind: "thinking",
                sidechainId: null,
                delta: { t: "plain", v: { k: "v" } },
                createdAt: 123,
            });

            await assertNoEphemeral(socket, 500);
        } finally {
            socket.close();
        }
    }, 30_000);

    it("relays encrypted transcript-draft deltas for e2ee sessions", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}` }, select: { id: true } });
        const token = await auth.createToken(account.id);

        const sessionId = "s-e2ee-2";
        await db.session.create({
            data: { id: sessionId, tag: `t-${Date.now()}`, accountId: account.id, encryptionMode: "e2ee", metadata: "{}" },
        });

        server = await startSocketServer();
        const socket = connectSessionScopedSocket({ url: server.url, token, sessionId });
        try {
            await waitForConnect(socket);

            const createdAt = Date.now();
            socket.emit("transcript-draft", {
                sid: sessionId,
                localId: "l1",
                segmentKind: "assistant",
                sidechainId: null,
                delta: { t: "encrypted", c: "cipher" },
                createdAt,
            });

            const payload = await waitForEphemeral(socket, 3_000);
            expect(payload).toMatchObject({
                type: "transcript-draft",
                sessionId,
                localId: "l1",
                segmentKind: "assistant",
                sidechainId: null,
                delta: { t: "encrypted", c: "cipher" },
            });
            expect(payload.createdAt).toBeGreaterThanOrEqual(createdAt - 5_000);
            expect(payload.createdAt).toBeLessThanOrEqual(Date.now() + 5_000);
        } finally {
            socket.close();
        }
    }, 30_000);

    it("clamps transcript-draft createdAt timestamps to a bounded skew window", async () => {
        await withEnvPatch({ HAPPIER_TRANSCRIPT_DRAFT_CREATED_AT_MAX_SKEW_MS: "1" }, async () => {
            const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}` }, select: { id: true } });
            const token = await auth.createToken(account.id);

            const sessionId = "s-e2ee-clamp";
            await db.session.create({
                data: { id: sessionId, tag: `t-${Date.now()}`, accountId: account.id, encryptionMode: "e2ee", metadata: "{}" },
            });

            server = await startSocketServer();
            const socket = connectSessionScopedSocket({ url: server.url, token, sessionId });
            try {
                await waitForConnect(socket);

                const sentAt = Date.now();
                socket.emit("transcript-draft", {
                    sid: sessionId,
                    localId: "l1",
                    segmentKind: "assistant",
                    sidechainId: null,
                    delta: { t: "encrypted", c: "cipher" },
                    createdAt: sentAt + 60_000,
                });

                const payload = await waitForEphemeral(socket, 3_000);
                expect(payload.type).toBe("transcript-draft");
                expect(payload.sessionId).toBe(sessionId);
                expect(payload.createdAt).toBeGreaterThanOrEqual(sentAt - 5_000);
                expect(payload.createdAt).toBeLessThanOrEqual(Date.now() + 5_000);
            } finally {
                socket.close();
            }
        });
    }, 30_000);

    it("drops transcript-draft deltas above the configured max size", async () => {
        await withEnvPatch({ HAPPIER_TRANSCRIPT_DRAFT_MAX_BYTES: "10" }, async () => {
            const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}` }, select: { id: true } });
            const token = await auth.createToken(account.id);

            const sessionId = "s-e2ee-max-bytes";
            await db.session.create({
                data: { id: sessionId, tag: `t-${Date.now()}`, accountId: account.id, encryptionMode: "e2ee", metadata: "{}" },
            });

            server = await startSocketServer();
            const socket = connectSessionScopedSocket({ url: server.url, token, sessionId });
            try {
                await waitForConnect(socket);

                socket.emit("transcript-draft", {
                    sid: sessionId,
                    localId: "l1",
                    segmentKind: "assistant",
                    sidechainId: null,
                    delta: { t: "encrypted", c: "01234567890" }, // 11 bytes
                    createdAt: 123,
                });

                await assertNoEphemeral(socket, 500);
            } finally {
                socket.close();
            }
        });
    }, 30_000);

    it("drops encrypted transcript-draft deltas for plaintext sessions", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}` }, select: { id: true } });
        const token = await auth.createToken(account.id);

        const sessionId = "s-plain";
        await db.session.create({
            data: { id: sessionId, tag: `t-${Date.now()}`, accountId: account.id, encryptionMode: "plain", metadata: "{}" },
        });

        server = await startSocketServer();
        const socket = connectSessionScopedSocket({ url: server.url, token, sessionId });
        try {
            await waitForConnect(socket);

            socket.emit("transcript-draft", {
                sid: sessionId,
                localId: "l1",
                segmentKind: "thinking",
                sidechainId: null,
                delta: { t: "encrypted", c: "cipher" },
                createdAt: 123,
            });

            await assertNoEphemeral(socket, 500);
        } finally {
            socket.close();
        }
    }, 30_000);

    it("relays plaintext transcript-draft deltas for plaintext sessions", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}` }, select: { id: true } });
        const token = await auth.createToken(account.id);

        const sessionId = "s-plain-2";
        await db.session.create({
            data: { id: sessionId, tag: `t-${Date.now()}`, accountId: account.id, encryptionMode: "plain", metadata: "{}" },
        });

        server = await startSocketServer();
        const socket = connectSessionScopedSocket({ url: server.url, token, sessionId });
        try {
            await waitForConnect(socket);

            const createdAt = Date.now();
            socket.emit("transcript-draft", {
                sid: sessionId,
                localId: "l1",
                segmentKind: "assistant",
                sidechainId: null,
                delta: { t: "plain", v: { k: "v" } },
                createdAt,
            });

            const payload = await waitForEphemeral(socket, 3_000);
            expect(payload).toMatchObject({
                type: "transcript-draft",
                sessionId,
                localId: "l1",
                segmentKind: "assistant",
                sidechainId: null,
                delta: { t: "plain", v: { k: "v" } },
            });
            expect(payload.createdAt).toBeGreaterThanOrEqual(createdAt - 5_000);
            expect(payload.createdAt).toBeLessThanOrEqual(Date.now() + 5_000);
        } finally {
            socket.close();
        }
    }, 30_000);
});
