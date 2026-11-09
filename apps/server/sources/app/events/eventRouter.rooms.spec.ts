import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { register } from "@/app/monitoring/metrics/registry";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { eventRouter } from "./eventRouter";
import type { SessionAccessProjectionRow } from "@/app/session/access/sessionAccess";
import type { ClientConnection } from "./eventPayloadTypes";
import type { LocalSocketRoomEmitter, SocketRoomEmitter } from "./socketRoomEmitter";
import { MACHINE_ACCESS_LOSS_EVENT } from './machineAccessLoss';
import { buildNewMessageUpdate, buildUpdateSessionUpdate } from "./eventPayloadBuilders";
import { registerSessionConsumptionSocketEvent, readSessionSocketConsumption } from "@/app/api/socket/sessionConsumption";
import { SessionConsumptionReplaceAckV1Schema, UpdateContainerSchema } from "@happier-dev/protocol";

const { findSession, transactionBoundary } = vi.hoisted(() => ({
    findSession: vi.fn(),
    transactionBoundary: {
        failCommits: 0,
        committed: false,
        projectionReadsPerSnapshot: [] as number[],
        error: new Error("commit unavailable"),
    },
}));

vi.mock("@/storage/db", async () => {
    const { inTxPostgresControlStatementMock } = await import("@/app/api/testkit/dbMocks");
    return {
        // Persistence is the boundary; inTx and credential authorization remain real.
        db: {
            session: { findUnique: findSession },
            $transaction: async (read: (tx: object) => Promise<unknown>) => {
                transactionBoundary.committed = false;
                const firstRead = findSession.mock.calls.length;
                const result = await read({
                    ...inTxPostgresControlStatementMock,
                    session: { findUnique: findSession, findFirst: async () => null },
                    account: { findUnique: async () => null },
                    ephemeralRunnerActivation: { findFirst: async () => null },
                    machine: { findFirst: async () => null },
                    accessKey: { findUnique: async () => null },
                });
                transactionBoundary.projectionReadsPerSnapshot.push(findSession.mock.calls.slice(firstRead)
                    .filter(([query]) => query.select.account).length);
                if (transactionBoundary.failCommits > 0) {
                    transactionBoundary.failCommits -= 1;
                    throw transactionBoundary.error;
                }
                transactionBoundary.committed = true;
                return result;
            },
        },
    };
});

type MetricSample = {
    labels: Record<string, string>;
    value: number;
};

async function readMetricSamples(name: string): Promise<MetricSample[]> {
    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((entry) => entry.name === name);
    if (!metric) return [];
    return metric.values.map((value) => ({
        labels: Object.fromEntries(
            Object.entries(value.labels ?? {}).map(([key, labelValue]) => [key, String(labelValue)]),
        ),
        value: Number(value.value),
    }));
}

describe("eventRouter (rooms)", () => {
    it('pushes exact Machine access loss to other API nodes as well as retiring local access', () => {
        const room = { emit() {}, disconnectSockets() {} };
        const received: unknown[] = [];
        const local: unknown[] = [];
        const release = eventRouter.onMachineAccessLoss(input => local.push(input));
        eventRouter.setIo({ to: () => room }, { broadcastServerSideEvent: (event, payload) => { received.push({ event, payload }); } });
        try {
            eventRouter.disconnectMachineAndSessionSockets({ accountId: 'viewer', machineId: 'machine', sessionBindings: [] });
            expect(local).toEqual([{ accountId: 'viewer', machineId: 'machine' }]);
            expect(received).toEqual([{ event: MACHINE_ACCESS_LOSS_EVENT, payload: local[0] }]);
        } finally { release(); }
    });
    let envSnapshot: ReturnType<typeof snapshotEnv>;
    beforeEach(() => {
        envSnapshot = snapshotEnv();
        // This persistence boundary models PostgreSQL transactions; SQLite
        // snapshots use a separate real client rather than the mocked $transaction.
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPY_DB_PROVIDER: "postgres" });
        register.resetMetrics();
        transactionBoundary.failCommits = 0;
        transactionBoundary.committed = false;
        transactionBoundary.projectionReadsPerSnapshot = [];
    });

    afterEach(() => {
        eventRouter.clearIo();
        restoreEnv(envSnapshot);
        vi.restoreAllMocks();
    });

    it("admits socket-local replacements with the exact credential, fresh access and final connection admission", async () => {
        const row = {
            id: "session", primaryTeamId: null, accountId: "owner", account: { status: "active" }, seq: 1,
            currentStorageState: "hosted", acceptedThroughServerSeq: null, materializationPublicationId: null,
            materializedThroughSourceAt: null, publishedThroughServerSeq: null,
            shares: [], teamGrants: [], groupGrants: [],
        } satisfies SessionAccessProjectionRow;
        findSession.mockImplementation(async ({ where }) => where.id === "session" ? row : null);
        let replace!: (input: unknown, acknowledge: unknown) => void;
        let finishAdmission!: (allowed: boolean) => void;
        const admission = new Promise<boolean>(resolve => { finishAdmission = resolve; });
        const socket = {
            connected: true,
            data: { userId: "owner", clientType: "user-scoped", clientPurpose: "sync", authAuthority: "present_user" },
            on: (event: string, handler: typeof replace) => { if (event === "session-consumption-replace") replace = handler; },
        };
        registerSessionConsumptionSocketEvent(socket as unknown as ClientConnection["socket"], admission);
        const acknowledge = vi.fn();
        replace({ v: 1, liveSessionIds: ["session", "denied", "missing"], durableSessionIds: ["session"] }, acknowledge);
        await Promise.resolve();
        expect(acknowledge).not.toHaveBeenCalled();
        expect(readSessionSocketConsumption(socket.data, "session")).toEqual({ durableBodies: false, liveSegments: false });
        finishAdmission(true);
        await vi.waitFor(() => expect(acknowledge).toHaveBeenCalled());
        expect(SessionConsumptionReplaceAckV1Schema.parse(acknowledge.mock.calls[0][0])).toEqual({
            ok: true, v: 1, liveSessionIds: ["session"], durableSessionIds: ["session"],
        });
        expect(readSessionSocketConsumption(socket.data, "session")).toEqual({ durableBodies: true, liveSegments: true });
        const request = (input: unknown) => new Promise<unknown>(resolve => { replace(input, resolve); });
        expect(await request({ v: 1, liveSessionIds: [], durableSessionIds: ["session"], accountId: "owner" }))
            .toEqual({ ok: false, error: "invalid_request" });
        expect(await request({ v: 1, liveSessionIds: [], durableSessionIds: ["session"] }))
            .toEqual({ ok: true, v: 1, liveSessionIds: [], durableSessionIds: ["session"] });
        expect(readSessionSocketConsumption(socket.data, "session")).toEqual({ durableBodies: true, liveSegments: false });
        socket.data.clientPurpose = "concurrent-server-cache";
        expect(await request({ v: 1, liveSessionIds: ["session"], durableSessionIds: [] }))
            .toEqual({ ok: true, v: 1, liveSessionIds: ["session"], durableSessionIds: [] });
        findSession.mockImplementation(async ({ where }) => where.id === "session" ? { ...row, account: { status: "disabled" } } : null);
        expect(await request({ v: 1, liveSessionIds: ["session"], durableSessionIds: [] }))
            .toEqual({ ok: true, v: 1, liveSessionIds: [], durableSessionIds: [] });
        socket.data.clientPurpose = "cli";
        expect(await request({ v: 1, liveSessionIds: ["session"], durableSessionIds: [] }))
            .toEqual({ ok: false, error: "not_allowed" });
        socket.connected = false;
        socket.data.clientPurpose = "sync";
        expect(await request({ v: 1, liveSessionIds: ["session"], durableSessionIds: [] }))
            .toEqual({ ok: false, error: "not_allowed" });
    });

    it.each([
        ["local", "owner"], ["receiving-node", "owner"],
        ["local", "recipient"], ["receiving-node", "recipient"],
    ] as const)("delivers bodies by demand and preserves %s %s metadata", async (mode, accountId) => {
        findSession.mockResolvedValue({
            metadataLayoutVersion: 1,
            id: "session", primaryTeamId: null, accountId: "owner", account: { status: "active" }, seq: 1,
            currentStorageState: "hosted", acceptedThroughServerSeq: null, materializationPublicationId: null,
            materializedThroughSourceAt: null, publishedThroughServerSeq: null,
            shares: [{ id: "share", sharedWithUserId: "recipient", accessLevel: "view", canApprovePermissions: false }],
            teamGrants: [], groupGrants: [],
        } satisfies SessionAccessProjectionRow & { metadataLayoutVersion: number });
        const received = new Map<string, unknown[]>();
        const sockets = ["hidden", "live", "durable", "concurrent", "scoped-rpc", "runtime"].map(id => ({
            id,
            data: {
                userId: accountId, authAuthority: "present_user", clientType: "user-scoped",
                clientPurpose: id === "concurrent" ? "concurrent-server-cache" : id === "runtime" ? "cli" : id === "scoped-rpc" ? "scoped-rpc" : "sync",
                sessionConsumption: {
                    liveSessionIds: new Set(id === "live" ? ["session"] : []),
                    durableSessionIds: new Set(id === "durable" ? ["session"] : []),
                },
            },
            emit: (_event: string, payload: unknown) => { received.set(id, [...received.get(id) ?? [], payload]); },
        }));
        const io: LocalSocketRoomEmitter = {
            in: () => ({ fetchSockets: async () => sockets }),
            to: ids => ({ emit: (event, payload) => { for (const id of [ids].flat()) sockets.find(socket => socket.id === id)?.emit(event, payload); }, disconnectSockets: () => {} }),
        };
        const connections: ClientConnection[] = sockets.map(socket => ({
            connectionType: "user-scoped", userId: accountId, socket: socket as unknown as ClientConnection["socket"],
        }));
        if (mode === "local") for (const connection of connections) eventRouter.addConnection(accountId, connection);
        const payload = buildNewMessageUpdate({ id: "message", seq: 1, localId: null,
            content: { t: "plain", v: { text: "private transcript" } }, createdAt: new Date(1), updatedAt: new Date(2) }, "session", 1, "event");
        const deliver = async (eventName: "update" | "ephemeral", body: unknown) => {
            if (mode === "receiving-node") await eventRouter.receiveCredentialQualifiedSessionDelivery(io, {
                v: 1, accountId, sessionId: "session", eventName, payload: body,
            });
            else if (eventName === "update") await eventRouter.emitUpdate({ userId: accountId, payload: body as typeof payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: "session" } });
            else await eventRouter.emitEphemeral({ userId: accountId, payload: body as Parameters<typeof eventRouter.emitEphemeral>[0]["payload"],
                recipientFilter: { type: "all-interested-in-session", sessionId: "session" } });
        };
        try {
            await deliver("update", payload);
            for (const id of ["hidden", "concurrent", "scoped-rpc"]) expect(received.get(id)).toEqual([expect.objectContaining({
                body: expect.objectContaining({ delivery: "hint", message: expect.not.objectContaining({ content: expect.anything() }) }),
            })]);
            for (const id of ["live", "durable", "runtime"]) expect(received.get(id)).toEqual([expect.objectContaining({
                body: expect.objectContaining({ delivery: "full", message: expect.objectContaining({ content: { t: "plain", v: { text: "private transcript" } } }) }),
            })]);
            received.clear();
            const metadataUpdate = buildUpdateSessionUpdate("session", 2, "metadata-event",
                { version: 7, value: "private-metadata".repeat(1024) }, { version: 4, value: "private-agent-state" },
                { active: true, pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 });
            // The real generic producer does not assert a metadata layout.
            // Payload documents and access projections are not credential ownership
            // evidence: both kinds of reader must work without either field.
            for (const includeOwnerMetadata of accountId === "owner" ? [false, true] : [false]) {
                if (includeOwnerMetadata) metadataUpdate.body.ownerMetadata = { value: { t: "plain", v: { v: 1 } } };
                await deliver("update", metadataUpdate);
                for (const id of ["hidden", "concurrent", "scoped-rpc"]) {
                    const [update] = received.get(id)!;
                    expect(UpdateContainerSchema.safeParse(update).success).toBe(true);
                    if (accountId === "recipient") {
                        expect(update).toEqual(metadataUpdate);
                        continue;
                    }
                    expect(update).toMatchObject({ body: { metadataDocument: "omitted", metadataVersion: 7,
                        metadataLayoutVersion: 1, agentState: { version: 4, value: "private-agent-state" },
                        active: true, pendingPermissionRequestCount: 1 } });
                    expect(update).not.toHaveProperty("body.metadata");
                    expect(update).not.toHaveProperty("body.ownerMetadata");
                    const fullBytes = Buffer.byteLength(JSON.stringify(metadataUpdate));
                    const hintBytes = Buffer.byteLength(JSON.stringify(update));
                    expect(hintBytes).toBeLessThan(fullBytes);
                    if (mode === "local" && id === "hidden") console.info("L20 constructed metadata frame bytes", { fullBytes, hintBytes });
                }
                for (const id of ["live", "durable", "runtime"]) expect(received.get(id)).toEqual([metadataUpdate]);
                received.clear();
            }
            received.clear();
            await deliver("ephemeral", { type: "transcript-stream-segment-delta", sessionId: "session", segmentId: "segment", tick: 1 });
            expect([...received.keys()]).toEqual(["live", "runtime"]);
        } finally {
            if (mode === "local") for (const connection of connections) eventRouter.removeConnection(accountId, connection);
        }
    });

    it("throws when HAPPY_SOCKET_ROOMS_ONLY=1 and io is not initialized", () => {
        const envSnapshot = snapshotEnv();
        applyEnvValues({
            HAPPY_SOCKET_ROOMS_ONLY: "1",
        });
        try {
            expect(() =>
                eventRouter.emitUpdate({
                    userId: "u1",
                    payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
                    recipientFilter: { type: "user-scoped-only" },
                }),
            ).toThrow(/HAPPY_SOCKET_ROOMS_ONLY=1/);
        } finally {
            restoreEnv(envSnapshot);
        }
    });

    it("routes user-scoped-only to user-scoped room", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
            recipientFilter: { type: "user-scoped-only" },
        });

        expect(ioTo).toHaveBeenCalledWith("user-scoped:u1");
        expect(emit).toHaveBeenCalledWith("update", expect.anything());
    });

    it("routes all-user-authenticated-connections to user room", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitEphemeral({
            userId: "u1",
            payload: { type: "machine-status", machineId: "m1" } as any,
            recipientFilter: { type: "all-user-authenticated-connections" },
        });

        expect(ioTo).toHaveBeenCalledWith("user:u1");
        expect(emit).toHaveBeenCalledWith("ephemeral", expect.anything());
    });

    it("fails closed for protected Session payloads when the Session no longer exists", async () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);
        findSession.mockResolvedValue(null);

        await eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        expect(ioTo).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });

    it.each(["room", "local", "receiving-node"] as const)(
        "reads one structural snapshot while independently qualifying every %s socket",
        async (mode) => {
            const row = {
                id: "session", primaryTeamId: null, accountId: "owner", account: { status: "active" }, seq: 0,
                currentStorageState: "hosted", acceptedThroughServerSeq: null, materializationPublicationId: null,
                materializedThroughSourceAt: null, publishedThroughServerSeq: null,
                shares: [], teamGrants: [], groupGrants: [],
            } satisfies SessionAccessProjectionRow;
            findSession.mockReset();
            findSession.mockResolvedValue(row);
            const delivered: string[] = [];
            const emittedAfterCommit: boolean[] = [];
            const emit = (socketId: string) => {
                delivered.push(socketId);
                emittedAfterCommit.push(transactionBoundary.committed);
            };
            const sockets = Array.from({ length: 12 }, (_, index) => ({
                id: `qualified-${index}`,
                data: { userId: "owner", clientType: "user-scoped", authAuthority: "present_user" },
            }));
            const tokenSocket = {
                id: "restricted-token",
                data: {
                    userId: "owner", clientType: "user-scoped", authAuthority: "account_automation",
                    apiTokenPrincipal: { grant: {
                        v: 1, actions: { families: [], ids: ["session.goal.set"] }, targets: null,
                        approve: false, origins: [], models: null, permissionModes: null, create: null,
                    } },
                },
            };
            const staleRuntimeSocket = {
                id: "revoked-runtime",
                data: {
                    userId: "owner", clientType: "user-scoped", authAuthority: "account_automation",
                    ephemeralRunnerAdmission: { kind: "session-runtime", principal: {
                        kind: "ephemeral_session_runner", authority: "session_runtime", accountId: "owner",
                        activationId: "activation", sessionId: "session", machineId: "machine",
                        installationId: "installation", installationPublicKey: "public-key", creatorTokenEpoch: 0,
                    } },
                },
            };
            const candidates = [...sockets, tokenSocket, staleRuntimeSocket, {
                id: "malformed", data: { userId: "owner", clientType: "user-scoped" },
            }];
            const io = {
                in: () => ({ fetchSockets: async () => candidates }),
                to: (room: string | string[]) => ({
                    emit: () => { for (const socketId of [room].flat()) emit(socketId); }, disconnectSockets: () => {},
                }),
            } satisfies LocalSocketRoomEmitter;
            const connections: ClientConnection[] = [];
            if (mode === "local") {
                for (const candidate of candidates) {
                    const connection: ClientConnection = {
                        connectionType: "user-scoped", userId: "owner",
                        // Only the Socket.IO boundary is represented by this socket fixture.
                        socket: { ...candidate, emit: () => emit(candidate.id) } as unknown as ClientConnection["socket"],
                    };
                    connections.push(connection);
                    eventRouter.addConnection("owner", connection);
                }
            } else {
                eventRouter.setIo(io satisfies SocketRoomEmitter);
            }
            const payload = { id: "delivery", seq: 1, createdAt: 0, body: { t: "delete-session" as const, sid: "session" } };
            const deliver = () => mode === "receiving-node"
                ? eventRouter.receiveCredentialQualifiedSessionDelivery(io, {
                    v: 1, accountId: "owner", sessionId: "session", eventName: "update", payload,
                })
                : eventRouter.emitUpdate({ userId: "owner", payload,
                    recipientFilter: { type: "all-interested-in-session", sessionId: "session" } });
            try {
                await deliver();
                expect(delivered).toEqual([...sockets.map(socket => socket.id), tokenSocket.id]);
                // Capture shares one structural read; the later policy-owned
                // readmission snapshot independently refreshes each credential.
                expect(transactionBoundary.projectionReadsPerSnapshot[0]).toBe(1);

                delivered.length = 0;
                emittedAfterCommit.length = 0;
                transactionBoundary.error = Object.assign(new Error("commit serialization conflict"), { code: "P2034" });
                transactionBoundary.failCommits = 1;
                await deliver();
                expect(delivered).toEqual([...sockets.map(socket => socket.id), tokenSocket.id]);
                expect(emittedAfterCommit).toEqual(Array.from({ length: 13 }, () => true));

                delivered.length = 0;
                transactionBoundary.error = new Error("commit unavailable");
                transactionBoundary.failCommits = 1;
                await expect(deliver()).resolves.toBeUndefined();
                expect(delivered).toEqual([]);

                findSession.mockImplementation(async query => {
                    if (query.select.account) throw new Error("structural projection unavailable");
                    return row;
                });
                await expect(deliver()).resolves.toBeUndefined();
                expect(delivered).toEqual([]);

                // The snapshot belongs to this delivery, so revocation is observed on the next one.
                findSession.mockResolvedValue({ ...row, account: { status: "suspended" } });
                delivered.length = 0;
                await deliver();
                expect(delivered).toEqual([]);
            } finally {
                for (const connection of connections) eventRouter.removeConnection("owner", connection);
            }
        },
    );

    it("sends one encoded emit per distinct payload across qualified sockets on a receiving node", async () => {
        const row = {
            id: "session", primaryTeamId: null, accountId: "owner", account: { status: "active" }, seq: 0,
            currentStorageState: "hosted", acceptedThroughServerSeq: null, materializationPublicationId: null,
            materializedThroughSourceAt: null, publishedThroughServerSeq: null,
            shares: [], teamGrants: [], groupGrants: [],
        } satisfies SessionAccessProjectionRow;
        findSession.mockReset();
        findSession.mockResolvedValue(row);
        const sockets = Array.from({ length: 12 }, (_, index) => ({
            id: `qualified-${index}`,
            data: { userId: "owner", clientType: "user-scoped", authAuthority: "present_user" },
        }));
        const emits: Array<{ rooms: string[]; payload: unknown }> = [];
        const io = {
            in: () => ({ fetchSockets: async () => sockets }),
            to: (room: string | string[]) => ({
                emit: (_event: string, payload: unknown) => {
                    emits.push({ rooms: Array.isArray(room) ? room : [room], payload });
                },
                disconnectSockets: () => {},
            }),
        } satisfies LocalSocketRoomEmitter;
        const payload = { id: "delivery", seq: 1, createdAt: 0, body: { t: "delete-session" as const, sid: "session" } };

        await eventRouter.receiveCredentialQualifiedSessionDelivery(io, {
            v: 1, accountId: "owner", sessionId: "session", eventName: "update", payload,
        });

        expect(emits).toHaveLength(1);
        expect(emits[0]!.rooms.sort()).toEqual(sockets.map(socket => socket.id).sort());
        expect(emits[0]!.payload).toEqual(payload);
    });

    it("shares one hint projection across sockets that are not consuming the Session", async () => {
        const row = {
            id: "session", primaryTeamId: null, accountId: "owner", account: { status: "active" }, seq: 0,
            currentStorageState: "hosted", acceptedThroughServerSeq: null, materializationPublicationId: null,
            materializedThroughSourceAt: null, publishedThroughServerSeq: null,
            shares: [], teamGrants: [], groupGrants: [],
        } satisfies SessionAccessProjectionRow;
        findSession.mockReset();
        findSession.mockResolvedValue(row);
        const sockets = Array.from({ length: 6 }, (_, index) => ({
            id: `hint-${index}`,
            data: {
                userId: "owner", clientType: "user-scoped", authAuthority: "present_user", clientPurpose: "sync",
                sessionConsumption: { liveSessionIds: new Set<string>(), durableSessionIds: new Set<string>() },
            },
        }));
        const emits: Array<{ rooms: string[]; payload: { body: { delivery: string; message: object } } }> = [];
        const io = {
            in: () => ({ fetchSockets: async () => sockets }),
            to: (room: string | string[]) => ({
                emit: (_event: string, payload: unknown) => {
                    emits.push({ rooms: Array.isArray(room) ? room : [room],
                        payload: payload as { body: { delivery: string; message: object } } });
                },
                disconnectSockets: () => {},
            }),
        } satisfies LocalSocketRoomEmitter;
        const payload = buildNewMessageUpdate({ id: "message", seq: 1, localId: null,
            content: { t: "plain", v: { text: "private transcript" } }, createdAt: new Date(1), updatedAt: new Date(2) },
            "session", 1, "delivery");

        await eventRouter.receiveCredentialQualifiedSessionDelivery(io, {
            v: 1, accountId: "owner", sessionId: "session", eventName: "update", payload,
        });

        expect(emits).toHaveLength(1);
        expect(emits[0]!.rooms.sort()).toEqual(sockets.map(socket => socket.id).sort());
        expect(emits[0]!.payload.body.delivery).toBe("hint");
        expect(emits[0]!.payload.body.message).not.toHaveProperty("content");
    });

    it("routes machine-scoped-only to machine + user-scoped rooms", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "update-machine" }, createdAt: 0 } as any,
            recipientFilter: { type: "machine-scoped-only", machineId: "m1" },
        });

        expect(ioTo).toHaveBeenCalledWith(["machine:m1:u1", "user-scoped:u1"]);
        expect(emit).toHaveBeenCalledWith("update", expect.anything());
    });

    it("routes machine-only to machine room only", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "update-machine" }, createdAt: 0 } as any,
            recipientFilter: { type: "machine-only", machineId: "m1" },
        });

        expect(ioTo).toHaveBeenCalledWith("machine:m1:u1");
        expect(emit).toHaveBeenCalledWith("update", expect.anything());
    });

    it("routes user-machine-scoped-only to the aggregate machine room", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "account-settings-changed" }, createdAt: 0 } as any,
            recipientFilter: { type: "user-machine-scoped-only" },
        });

        expect(ioTo).toHaveBeenCalledWith("user-machines:u1");
        expect(emit).toHaveBeenCalledWith("update", expect.anything());
    });

    it("routes AccountChange wakes only to V3 stored-content sockets", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "account-change" }, createdAt: 0 } as any,
            recipientFilter: { type: "account-stored-content-v3" } as any,
        });

        expect(ioTo).toHaveBeenCalledWith("account-stored-content-v3:u1");
        expect(emit).toHaveBeenCalledWith("update", expect.anything());
    });

    it("never emits per-account update containers to shared session/machine rooms", async () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        await eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        await eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "update-machine" }, createdAt: 0 } as any,
            recipientFilter: { type: "machine-scoped-only", machineId: "m1" },
        });

        await eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "update-machine" }, createdAt: 0 } as any,
            recipientFilter: { type: "machine-only", machineId: "m1" },
        });

        const targets = ioTo.mock.calls.map(([arg]) => arg);
        const flatTargets = targets.flatMap((t) => (Array.isArray(t) ? t : [t]));

        expect(flatTargets).not.toContain("session:s1");
        expect(flatTargets).not.toContain("machine:m1");
    });

    it("uses except() when skipSenderConnection is provided", () => {
        const except = vi.fn().mockReturnValue({ emit: vi.fn() });
        const ioTo = vi.fn().mockReturnValue({ except });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
            recipientFilter: { type: "user-scoped-only" },
            skipSenderConnection: { socket: { id: "sock-1" } } as any,
        });

        expect(except).toHaveBeenCalledWith("sock-1");
    });

    it("records room fanout target counts for room-based dispatch", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const ioTo = vi.fn().mockReturnValue({ emit: vi.fn() });
        eventRouter.setIo({ to: ioTo } as any);

        await eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
            recipientFilter: { type: "user-scoped-only" },
        });

        const samples = await readMetricSamples("event_fanout_emits_total");
        expect(samples).toContainEqual({
            labels: {
                dispatch_mode: "room",
                event_name: "update",
                filter_type: "user-scoped-only",
            },
            value: 1,
        });

        const payloadSamples = await readMetricSamples("event_fanout_payload_bytes");
        expect(payloadSamples).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    labels: expect.objectContaining({
                        dispatch_mode: "room",
                        event_name: "update",
                        filter_type: "user-scoped-only",
                        payload_type: "new-message",
                    }),
                }),
            ]),
        );
    });

    it("samples room fanout payload byte metrics instead of measuring every emission", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        const ioTo = vi.fn().mockReturnValue({ emit: vi.fn() });
        eventRouter.setIo({ to: ioTo } as any);

        await eventRouter.emitEphemeral({
            userId: "u1",
            payload: {
                type: "transcript-stream-segment",
                sessionId: "s1",
                message: { accumulatedText: "x".repeat(100_000) },
            } as any,
            recipientFilter: { type: "user-scoped-only" },
        });

        const emitSamples = await readMetricSamples("event_fanout_emits_total");
        expect(emitSamples).toContainEqual({
            labels: {
                dispatch_mode: "room",
                event_name: "ephemeral",
                filter_type: "user-scoped-only",
            },
            value: 1,
        });
        expect(await readMetricSamples("event_fanout_payload_bytes")).toEqual([]);
    });
});

describe('focused computer room query', () => {
    afterEach(() => eventRouter.clearIo());
    it('checks remote adapter socket data and excludes phone, daemon, legacy and blurred sockets', async () => {
        const fetchSockets = vi.fn().mockResolvedValue([
            { id: 'phone', data: { clientType: 'user-scoped', clientPurpose: 'sync', uiFocus: { computer: false, focused: true } } },
            { id: 'machine', data: { clientType: 'machine-scoped', clientPurpose: 'sync', uiFocus: { computer: true, focused: true } } },
            { id: 'legacy', data: { clientType: 'user-scoped', clientPurpose: 'sync' } },
            { id: 'blurred', data: { clientType: 'user-scoped', clientPurpose: 'sync', uiFocus: { computer: true, focused: false } } },
        ]);
        const inRoom = vi.fn(() => ({ fetchSockets }));
        eventRouter.setIo({ in: inRoom, to: vi.fn(() => ({ emit: vi.fn(), disconnectSockets: vi.fn() })) });
        expect(await eventRouter.hasFocusedComputerUi('account')).toBe(false);
        expect(inRoom).toHaveBeenCalledWith('user-scoped:account');
        fetchSockets.mockResolvedValue([{ id: 'focused', data: { clientType: 'user-scoped', clientPurpose: 'sync', uiFocus: { computer: true, focused: true } } }]);
        expect(await eventRouter.hasFocusedComputerUi('account')).toBe(true);
        fetchSockets.mockRejectedValue(new Error('adapter unavailable'));
        expect(await eventRouter.hasFocusedComputerUi('account')).toBe(false);
    });
});
