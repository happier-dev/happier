import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { register } from "@/app/monitoring/metrics/registry";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { eventRouter } from "./eventRouter";
import type { SessionAccessProjectionRow } from "@/app/session/access/sessionAccess";
import type { ClientConnection } from "./eventPayloadTypes";
import type { LocalSocketRoomEmitter, SocketRoomEmitter } from "./socketRoomEmitter";

const { findSession, transactionBoundary } = vi.hoisted(() => ({
    findSession: vi.fn(),
    transactionBoundary: {
        failCommits: 0,
        committed: false,
        error: new Error("commit unavailable"),
    },
}));

vi.mock("@/storage/db", () => ({
    // Persistence is the boundary; inTx and credential authorization remain real.
    db: {
        session: { findUnique: findSession },
        $transaction: async (read: (tx: object) => Promise<unknown>) => {
            transactionBoundary.committed = false;
            const result = await read({
            session: { findUnique: findSession, findFirst: async () => null },
            account: { findUnique: async () => null },
            ephemeralRunnerActivation: { findFirst: async () => null },
            machine: { findFirst: async () => null },
            accessKey: { findUnique: async () => null },
            });
            if (transactionBoundary.failCommits > 0) {
                transactionBoundary.failCommits -= 1;
                throw transactionBoundary.error;
            }
            transactionBoundary.committed = true;
            return result;
        },
    },
}));

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
    beforeEach(() => {
        register.resetMetrics();
        transactionBoundary.failCommits = 0;
        transactionBoundary.committed = false;
    });

    afterEach(() => {
        eventRouter.clearIo();
        vi.restoreAllMocks();
    });

    it("disconnects only the Account terminal room after a policy change", () => {
        const connections = [
            { room: "account-terminal:u1", connected: true },
            { room: "account-terminal:u2", connected: true },
            { room: "user:u1", connected: true },
        ];
        // Socket.IO is the transport boundary; the router and room selection remain real.
        eventRouter.setIo({
            to: (room: string) => ({ disconnectSockets: () => {
                for (const connection of connections) {
                    if (connection.room === room) connection.connected = false;
                }
            } }),
        } as unknown as Parameters<typeof eventRouter.setIo>[0]);
        eventRouter.disconnectAccountTerminalSockets("u1");
        expect(connections.map((connection) => connection.connected)).toEqual([false, true, true]);
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
                    emit: () => emit(String(room)), disconnectSockets: () => {},
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
                // Repeated structural reads are the measured fan-out cost, not incidental wiring.
                const projectionReads = findSession.mock.calls.filter(([query]) => query.select.account);
                expect(projectionReads).toHaveLength(1);

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
