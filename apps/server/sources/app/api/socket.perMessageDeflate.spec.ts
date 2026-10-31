import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo, Socket as NetSocket } from "node:net";

import { auth } from "@/app/auth/auth";
import { eventRouter } from "@/app/events/eventRouter";
import type { EphemeralPayload } from "@/app/events/eventPayloadTypes";
import type { Fastify as AppFastify } from "./types";
import {
    DEFAULT_SOCKET_PERMESSAGE_DEFLATE_THRESHOLD,
    resolveSocketPerMessageDeflateFromEnv,
    startSocket,
} from "./socket";

// Genuine system boundaries only (Postgres via Prisma, Redis, connection auth storage).
// The socket.io/engine.io/ws network stack under test stays completely real.
vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: vi.fn(),
            // Connect-time presence snapshot reads the account's live fleet; empty in tests.
            findMany: vi.fn(async () => []),
        },
    },
}));
vi.mock("@/storage/redis/redis", () => ({
    getRedisClient: vi.fn(),
}));
vi.mock("@socket.io/redis-streams-adapter", () => ({
    createAdapter: vi.fn(),
}));
vi.mock("@/app/auth/auth", () => ({
    auth: {
        verifyToken: vi.fn<(token: string) => Promise<{ userId: string; extras?: unknown } | null>>(
            async () => null,
        ),
    },
}));
vi.mock("@/app/auth/enforceLoginEligibility", () => ({
    enforceLoginEligibility: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/monitoring/metrics2", () => ({
    websocketEventsCounter: { inc: vi.fn() },
    incrementWebSocketConnection: vi.fn(),
    decrementWebSocketConnection: vi.fn(),
    // Emitted on every eventRouter fanout (boundary mock, like the rest of this block).
    socketEmissionsCounter: { inc: vi.fn() },
    socketEmissionPayloadBytesHistogram: { observe: vi.fn() },
}));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const PERMESSAGE_DEFLATE_ENV_KEYS = [
    "HAPPIER_SOCKET_PERMESSAGE_DEFLATE",
    "HAPPY_SOCKET_PERMESSAGE_DEFLATE",
] as const;

beforeEach(() => {
    for (const key of PERMESSAGE_DEFLATE_ENV_KEYS) {
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of PERMESSAGE_DEFLATE_ENV_KEYS) {
        delete process.env[key];
    }
});

// `ws` is the WebSocket implementation engine.io (server) and engine.io-client
// (Node transports) actually negotiate with; loaded through createRequire because
// it is a transitive dependency of apps/server. ws ships no bundled TypeScript
// types here, so a narrow structural facade types the surface this spec uses.
const require = createRequire(import.meta.url);

interface WsClientLike {
    readonly extensions: string;
    readonly readyState: number;
    readonly CLOSED: number;
    close(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    send(data: string, callback?: (error?: Error) => void): void;
}

const { WebSocket: WsClient } = require("ws") as {
    WebSocket: new (url: string, options?: { perMessageDeflate?: boolean }) => WsClientLike;
};

type SocketServerHarness = Readonly<{
    port: number;
    close: () => Promise<void>;
}>;

async function startRealSocketServer(): Promise<SocketServerHarness> {
    const httpServer = createServer();
    startSocket({ server: httpServer } as unknown as AppFastify);
    await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
        throw new Error("Failed to bind the test http server");
    }
    return {
        port: address.port,
        close: async () => {
            httpServer.closeAllConnections();
            await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        },
    };
}

type UpgradeProbeResult = Readonly<{
    statusCode: number | undefined;
    extensionsHeader: string | undefined;
}>;

/**
 * Performs a raw WebSocket upgrade against the socket server and reports the
 * wire-level handshake outcome. This observes the RFC 7692 contract directly:
 * the `sec-websocket-extensions` response header is present exactly when the
 * server accepted the offered extension.
 */
function probeWebsocketUpgrade(
    port: number,
    params: Readonly<{ offerPerMessageDeflate: boolean }>,
): Promise<UpgradeProbeResult> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: "127.0.0.1",
            port,
            path: "/v1/updates/?EIO=4&transport=websocket",
            headers: {
                connection: "Upgrade",
                upgrade: "websocket",
                "sec-websocket-version": "13",
                "sec-websocket-key": randomBytes(16).toString("base64"),
                ...(params.offerPerMessageDeflate ? { "sec-websocket-extensions": "permessage-deflate" } : {}),
            },
        });
        req.on("upgrade", (res, socket) => {
            const raw = res.headers["sec-websocket-extensions"];
            socket.destroy();
            resolve({
                statusCode: res.statusCode,
                extensionsHeader: Array.isArray(raw) ? raw.join(", ") : raw,
            });
        });
        req.on("response", (res) => {
            resolve({ statusCode: res.statusCode, extensionsHeader: undefined });
        });
        req.on("error", reject);
        req.end();
    });
}

/**
 * Opens a real WebSocket connection that offers permessage-deflate (the same
 * negotiation the production engine.io-client performs by default) and reports
 * the extension negotiated on the live connection, via ws's public
 * `extensions` accessor (node_modules/ws/lib/websocket.js).
 */
function negotiateOnLiveConnection(
    port: number,
): Promise<Readonly<{ open: boolean; extensions: string; close: () => Promise<void> }>> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("timed out opening the websocket connection"));
        }, 10_000);
        const ws = new WsClient(`ws://127.0.0.1:${port}/v1/updates/?EIO=4&transport=websocket`, {
            perMessageDeflate: true,
        });
        ws.on("open", () => {
            clearTimeout(timeout);
            resolve({
                open: true,
                extensions: ws.extensions,
                close: () =>
                    new Promise<void>((resolveClose) => {
                        if (ws.readyState === ws.CLOSED) return resolveClose();
                        ws.on("close", () => resolveClose());
                        ws.close();
                    }),
            });
        });
        ws.on("error", (error: unknown) => {
            clearTimeout(timeout);
            reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
}

describe("resolveSocketPerMessageDeflateFromEnv", () => {
    it("defaults to permessage-deflate enabled with the engine.io default threshold", () => {
        expect(resolveSocketPerMessageDeflateFromEnv({})).toEqual({ threshold: DEFAULT_SOCKET_PERMESSAGE_DEFLATE_THRESHOLD });
        expect(DEFAULT_SOCKET_PERMESSAGE_DEFLATE_THRESHOLD).toBe(1_024);
    });

    it("reads an explicit disable from env", () => {
        expect(resolveSocketPerMessageDeflateFromEnv({ HAPPIER_SOCKET_PERMESSAGE_DEFLATE: "0" })).toBe(false);
        expect(resolveSocketPerMessageDeflateFromEnv({ HAPPIER_SOCKET_PERMESSAGE_DEFLATE: "off" })).toBe(false);
        expect(resolveSocketPerMessageDeflateFromEnv({ HAPPIER_SOCKET_PERMESSAGE_DEFLATE: "false" })).toBe(false);
        expect(resolveSocketPerMessageDeflateFromEnv({ HAPPY_SOCKET_PERMESSAGE_DEFLATE: "no" })).toBe(false);
    });

    it("keeps explicit enable values and unknown values on the default", () => {
        expect(resolveSocketPerMessageDeflateFromEnv({ HAPPIER_SOCKET_PERMESSAGE_DEFLATE: "1" })).toEqual({
            threshold: DEFAULT_SOCKET_PERMESSAGE_DEFLATE_THRESHOLD,
        });
        expect(resolveSocketPerMessageDeflateFromEnv({ HAPPIER_SOCKET_PERMESSAGE_DEFLATE: "true" })).toEqual({
            threshold: DEFAULT_SOCKET_PERMESSAGE_DEFLATE_THRESHOLD,
        });
        expect(resolveSocketPerMessageDeflateFromEnv({ HAPPIER_SOCKET_PERMESSAGE_DEFLATE: "nope" })).toEqual({
            threshold: DEFAULT_SOCKET_PERMESSAGE_DEFLATE_THRESHOLD,
        });
    });
});

describe("startSocket permessage-deflate negotiation", () => {
    let harness: SocketServerHarness | null = null;
    const openConnections: Array<Promise<void>> = [];

    afterEach(async () => {
        await Promise.all(openConnections.splice(0));
        if (harness) {
            const closing = harness.close();
            harness = null;
            await closing;
        }
    });

    it("advertises permessage-deflate on the websocket handshake by default", async () => {
        harness = await startRealSocketServer();

        const probe = await probeWebsocketUpgrade(harness.port, { offerPerMessageDeflate: true });

        expect(probe.statusCode).toBe(101);
        expect(probe.extensionsHeader).toContain("permessage-deflate");
    });

    it("negotiates the extension on a live websocket connection by default", async () => {
        harness = await startRealSocketServer();

        const connection = await negotiateOnLiveConnection(harness.port);
        openConnections.push(connection.close());

        expect(connection.open).toBe(true);
        expect(connection.extensions).toBe("permessage-deflate");
    });

    it("does not add the extension when the client does not offer it", async () => {
        // Negotiation is per connection: clients that never offer permessage-deflate
        // (some browser/React Native WebSocket stacks) must get a plain connection.
        harness = await startRealSocketServer();

        const probe = await probeWebsocketUpgrade(harness.port, { offerPerMessageDeflate: false });

        expect(probe.statusCode).toBe(101);
        expect(probe.extensionsHeader).toBeUndefined();
    });

    it("does not negotiate permessage-deflate when disabled via env", async () => {
        process.env.HAPPIER_SOCKET_PERMESSAGE_DEFLATE = "0";
        harness = await startRealSocketServer();

        const probe = await probeWebsocketUpgrade(harness.port, { offerPerMessageDeflate: true });
        const connection = await negotiateOnLiveConnection(harness.port);
        openConnections.push(connection.close());

        expect(probe.statusCode).toBe(101);
        expect(probe.extensionsHeader).toBeUndefined();
        expect(connection.extensions).toBe("");
    });
});

// === WIRE COMPRESSION PROOF ===
//
// The negotiation tests above prove the extension is ADVERTISED; they would still pass if
// compression silently did nothing. These tests measure the bytes that actually cross the
// client's underlying net socket for a large, incident-shaped payload (the ~17.4MB
// scm.status.snapshot fanout class): the wire must genuinely shrink in both directions,
// and the payload must survive the deflate round trip byte-identically.

const WIRE_TEST_USER_ID = "wire-deflate-user";
const WIRE_TEST_TOKEN = "wire-deflate-token";
const WIRE_SNAPSHOT_CSV_LINE_COUNT = 6_144;
const openWireConnections: Array<() => Promise<void>> = [];

function buildWireSnapshotCsvFixture(): string {
    // Incident class: a machine snapshot fanout full of near-identical usage-CSV paths.
    // Deterministic and massively redundant, so the asserted 2x wire bound stays far away
    // from real zlib behavior (~10x+ on this shape).
    return Array.from(
        { length: WIRE_SNAPSHOT_CSV_LINE_COUNT },
        (_, i) => `D/exp${i % 97}/usage/csv/fixture-usage-${i}.csv,${(i * 7) % 997},applied`,
    ).join("\n");
}

type WireSnapshotPayload = EphemeralPayload & { usageCsvSnapshotCsv: string };

function wireSnapshotPayload(): WireSnapshotPayload {
    // The socket wire path treats event payloads as opaque JSON, so the fixture rides the
    // real machine-status ephemeral push shape with the incident's large CSV body attached.
    return {
        type: "machine-status",
        machineId: "wire-deflate-fixture",
        online: true,
        timestamp: 0,
        usageCsvSnapshotCsv: buildWireSnapshotCsvFixture(),
    };
}

// Counts every byte handed to the client's net socket while installed, then restores the
// original write. Measurement-only patching of a real socket (ws's Sender emits frames
// through this exact method), not a mock boundary.
function countOutboundWriteBytes(socket: NetSocket): Readonly<{ stop: () => number }> {
    let totalBytes = 0;
    const originalWrite = socket.write;
    const countedWrite = function countedWrite(this: NetSocket, chunk: unknown, ...rest: unknown[]) {
        if (typeof chunk === "string") totalBytes += Buffer.byteLength(chunk, "utf8");
        else if (Buffer.isBuffer(chunk)) totalBytes += chunk.length;
        else if (Array.isArray(chunk)) {
            for (const part of chunk) {
                if (Buffer.isBuffer(part)) totalBytes += part.length;
            }
        }
        return (originalWrite as (this: NetSocket, ...args: unknown[]) => boolean).apply(this, [chunk, ...rest]);
    };
    socket.write = countedWrite as typeof socket.write;
    return {
        stop: () => {
            socket.write = originalWrite;
            return totalBytes;
        },
    };
}

type SocketIoWireProbe = Readonly<{
    ws: WsClientLike;
    rawSocket: NetSocket;
    readInboundWireBytes: () => number;
    sendSocketIoText: (socketIoPacket: string) => Promise<void>;
    waitForEvent: (name: string, timeoutMs?: number) => Promise<unknown[]>;
    close: () => Promise<void>;
}>;

/**
 * Opens a real deflate-negotiating websocket connection and completes the Socket.IO v4
 * namespace handshake over it (engine.io MESSAGE '4' + Socket.IO packet '40' with auth),
 * so the server middleware (auth.verifyToken mock) admits the probe as a user-scoped
 * client. Inbound wire bytes are counted from the client net socket's 'data' events.
 */
function connectSocketIoWireProbe(params: Readonly<{ port: number; token: string }>): Promise<SocketIoWireProbe> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("timed out opening the socket.io websocket connection"));
        }, 10_000);
        const ws = new WsClient(`ws://127.0.0.1:${params.port}/v1/updates/?EIO=4&transport=websocket`, {
            perMessageDeflate: true,
        });

        const fail = (error: unknown) => {
            clearTimeout(timeout);
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const receivedEvents: Array<{ name: string; args: unknown[] }> = [];
        const eventWaiters = new Map<string, Array<(args: unknown[]) => void>>();
        let inboundWireBytes = 0;

        ws.on("error", fail);
        ws.on("open", () => {
            // Socket.IO CONNECT via engine.io: MESSAGE ('4') + Socket.IO CONNECT ('0' + JSON auth).
            ws.send(`40${JSON.stringify({ token: params.token })}`);
        });
        ws.on("message", (...args: unknown[]) => {
            if (args[1] === true) return; // binary frame
            const chunk = args[0];
            const rawText = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
            // Engine.IO v4 layer: '0' open, '1' close, '2' ping, '3' pong, '4' message. The
            // engine pings every 15s; the probe never answers, which is safe for a test that
            // finishes well inside the 45s ping timeout.
            if (!rawText.startsWith("4")) return;
            // Socket.IO v5 layer: '0' CONNECT, '1' DISCONNECT, '2' EVENT, '4' CONNECT_ERROR.
            const packet = rawText.slice(1);
            if (packet.startsWith("0")) {
                // Server namespace CONNECT ack → handshake complete. Expose the raw socket.
                const rawSocket = (ws as unknown as { _socket?: NetSocket })._socket;
                if (!rawSocket) {
                    fail(new Error("ws client did not expose its underlying net socket; cannot measure wire bytes"));
                    return;
                }
                rawSocket.on("data", (dataChunk: Buffer) => {
                    inboundWireBytes += dataChunk.length;
                });
                clearTimeout(timeout);
                resolve({
                    ws,
                    rawSocket,
                    readInboundWireBytes: () => inboundWireBytes,
                    sendSocketIoText: (socketIoPacket) =>
                        new Promise((resolveSend, rejectSend) => {
                            ws.send(`4${socketIoPacket}`, (error?: Error) => (error ? rejectSend(error) : resolveSend()));
                        }),
                    waitForEvent: (name, timeoutMs = 10_000) =>
                        new Promise((resolveEvent, rejectEvent) => {
                            const existing = receivedEvents.find((event) => event.name === name);
                            if (existing) return resolveEvent(existing.args);
                            const eventTimer = setTimeout(() => {
                                rejectEvent(new Error(`timed out waiting for socket.io event '${name}'`));
                            }, timeoutMs);
                            const waiters = eventWaiters.get(name) ?? [];
                            waiters.push((eventArgs) => {
                                clearTimeout(eventTimer);
                                resolveEvent(eventArgs);
                            });
                            eventWaiters.set(name, waiters);
                        }),
                    close: () =>
                        new Promise((resolveClose) => {
                            if (ws.readyState === ws.CLOSED) return resolveClose();
                            ws.on("close", () => resolveClose());
                            ws.close();
                        }),
                });
                return;
            }
            if (packet.startsWith("4")) {
                fail(new Error(`socket.io rejected the connection: ${packet}`));
                return;
            }
            if (packet.startsWith("2")) {
                try {
                    const parsed = JSON.parse(packet.slice(1)) as [string, ...unknown[]];
                    const event = { name: parsed[0], args: parsed.slice(1) };
                    receivedEvents.push(event);
                    const waiters = eventWaiters.get(event.name);
                    if (waiters) {
                        eventWaiters.delete(event.name);
                        for (const waiter of waiters) waiter(event.args);
                    }
                } catch {
                    // Unparsable foreign frames must not break the probe; assertions judge content.
                }
            }
        });
    });
}

type WireRoundTripMeasurement = Readonly<{
    sentPayload: WireSnapshotPayload;
    receivedPayload: unknown;
    rawPayloadBytes: number;
    clientToServerBytes: number;
    serverToClientBytes: number;
    negotiatedExtensions: string;
}>;;

/**
 * Pushes one large snapshot through the real round trip:
 * 1. client → server: the probe emits the payload as a Socket.IO event frame; outbound
 *    bytes are counted while the client net socket's `write` is patched (post-compression).
 * 2. server → client (the incident direction): eventRouter.emitEphemeral — the canonical
 *    server→client fanout owner — pushes the same payload; inbound bytes are counted from
 *    the client net socket's 'data' events between trigger and full event receipt.
 */
async function measureUsageSnapshotWireRoundTrip(port: number, payload: WireSnapshotPayload): Promise<WireRoundTripMeasurement> {
    const probe = await connectSocketIoWireProbe({ port, token: WIRE_TEST_TOKEN });
    // Lazy closer: the connection must stay open through the measurements below.
    openWireConnections.push(() => probe.close());
    // Let the user-scoped connection handler's machine-presence snapshot flush before
    // baselining, so only the measured frame lands in the byte deltas.
    await new Promise((resolveSettle) => setTimeout(resolveSettle, 150));

    const rawPayloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    let clientToServerBytes = 0;
    const outbound = countOutboundWriteBytes(probe.rawSocket);
    try {
        await probe.sendSocketIoText(`2${JSON.stringify(["wire-compression-fixture-echo", payload])}`);
    } finally {
        clientToServerBytes = outbound.stop();
    }

    const inboundBefore = probe.readInboundWireBytes();
    eventRouter.emitEphemeral({
        userId: WIRE_TEST_USER_ID,
        payload,
        recipientFilter: { type: "all-user-authenticated-connections" },
    });
    const eventArgs = await probe.waitForEvent("ephemeral");
    const serverToClientBytes = probe.readInboundWireBytes() - inboundBefore;

    return {
        sentPayload: payload,
        receivedPayload: eventArgs[0],
        rawPayloadBytes,
        clientToServerBytes,
        serverToClientBytes,
        negotiatedExtensions: probe.ws.extensions,
    };
}

describe("startSocket permessage-deflate wire compression", () => {
    let harness: SocketServerHarness | null = null;

    beforeEach(() => {
        vi.mocked(auth.verifyToken).mockResolvedValue({ userId: WIRE_TEST_USER_ID });
    });

    afterEach(async () => {
        await Promise.all(openWireConnections.splice(0).map((closeConnection) => closeConnection()));
        if (harness) {
            const closing = harness.close();
            harness = null;
            await closing;
        }
        vi.mocked(auth.verifyToken).mockImplementation(async () => null);
    });

    it("compresses a large usage-snapshot frame on the wire in both directions by default", async () => {
        harness = await startRealSocketServer();

        const measurement = await measureUsageSnapshotWireRoundTrip(harness.port, wireSnapshotPayload());

        expect(measurement.negotiatedExtensions).toBe("permessage-deflate");
        // Compression must not corrupt: the consumer receives the exact payload.
        expect(measurement.receivedPayload).toEqual(measurement.sentPayload);
        expect((measurement.receivedPayload as WireSnapshotPayload).usageCsvSnapshotCsv).toBe(
            measurement.sentPayload.usageCsvSnapshotCsv,
        );
        // Generous 2x bound: repetitive snapshot text compresses 10x+, so a materially-below
        // result proves the wire shrank regardless of zlib level or small framing overhead.
        expect(measurement.clientToServerBytes * 2).toBeLessThan(measurement.rawPayloadBytes);
        expect(measurement.serverToClientBytes * 2).toBeLessThan(measurement.rawPayloadBytes);
    });

    it("transports the same snapshot at approximately full size when permessage-deflate is disabled", async () => {
        process.env.HAPPIER_SOCKET_PERMESSAGE_DEFLATE = "0";
        harness = await startRealSocketServer();

        const measurement = await measureUsageSnapshotWireRoundTrip(harness.port, wireSnapshotPayload());

        expect(measurement.negotiatedExtensions).toBe("");
        // Correctness without deflate: the payload still round-trips unchanged.
        expect(measurement.receivedPayload).toEqual(measurement.sentPayload);
        // Control: with no negotiated extension neither side compresses, so both directions
        // carry the serialized payload plus socket.io/engine.io framing (strictly more than
        // the payload JSON alone). This is what distinguishes "deflate works" from "the
        // payload was small".
        expect(measurement.clientToServerBytes).toBeGreaterThan(measurement.rawPayloadBytes);
        expect(measurement.serverToClientBytes).toBeGreaterThan(measurement.rawPayloadBytes);
    });
});
