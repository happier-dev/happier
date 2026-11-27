import { afterEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { eventRouter } from "./eventRouter";

const { socketEmissionPayloadBytesObserve, socketEmissionsInc } = vi.hoisted(() => ({
    socketEmissionPayloadBytesObserve: vi.fn(),
    socketEmissionsInc: vi.fn(),
}));

vi.mock("@/app/monitoring/metrics2", () => ({
    socketEmissionPayloadBytesHistogram: { observe: socketEmissionPayloadBytesObserve },
    socketEmissionsCounter: { inc: socketEmissionsInc },
}));

describe("eventRouter (rooms)", () => {
    afterEach(() => {
        eventRouter.clearIo();
        vi.restoreAllMocks();
        socketEmissionPayloadBytesObserve.mockReset();
        socketEmissionsInc.mockReset();
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

    it("routes session deliveries to disjoint room audiences that still reach legacy workers", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        const except = vi.fn(() => ({ emit }));
        ioTo.mockReturnValue({ emit, except });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        expect(ioTo).toHaveBeenCalledWith(["session:s1:u1", "user-scoped:u1"]);
        expect(except).toHaveBeenCalledWith("narrow-session-interest:u1");
        expect(ioTo).toHaveBeenCalledWith(["account-socket-session-interest:s1:u1"]);
        expect(emit).toHaveBeenCalledTimes(2);
    });

    it("keeps both session audiences for transcript streams and excludes passive sockets from each", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        const except = vi.fn(() => ({ emit }));
        ioTo.mockReturnValue({ emit, except });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitEphemeral({
            userId: "u1",
            payload: { type: "transcript-stream-segment-delta", sessionId: "s1" } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        expect(ioTo).toHaveBeenCalledWith(["session:s1:u1", "user-scoped:u1"]);
        expect(except).toHaveBeenCalledWith(["narrow-session-interest:u1", "live-transcript-disabled:u1"]);
        expect(ioTo).toHaveBeenCalledWith(["account-socket-session-interest:s1:u1"]);
        expect(except).toHaveBeenCalledWith("live-transcript-disabled:u1");
        expect(emit).toHaveBeenCalledTimes(2);
    });

    it("preserves matching runner delivery and excludes passive sockets from in-memory transcript streams", () => {
        const legacy = { emit: vi.fn() };
        const narrow = { emit: vi.fn() };
        const declared = { emit: vi.fn() };
        const sessionScoped = { emit: vi.fn() };
        eventRouter.addConnection("u1", { connectionType: "user-scoped", socket: legacy as any, userId: "u1" });
        eventRouter.addConnection("u1", { connectionType: "user-scoped", socket: narrow as any, userId: "u1", sessionUpdateInterest: "s1" });
        eventRouter.addConnection("u1", { connectionType: "user-scoped", socket: declared as any, userId: "u1", liveTranscriptDisabled: true });
        eventRouter.addConnection("u1", { connectionType: "session-scoped", socket: sessionScoped as any, userId: "u1", sessionId: "s1" });

        eventRouter.emitEphemeral({
            userId: "u1",
            payload: { type: "transcript-stream-segment-delta", sessionId: "s1" } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        expect(legacy.emit).toHaveBeenCalledWith("ephemeral", expect.anything());
        expect(sessionScoped.emit).toHaveBeenCalledWith("ephemeral", expect.anything());
        expect(narrow.emit).toHaveBeenCalledWith("ephemeral", expect.anything());
        expect(declared.emit).not.toHaveBeenCalled();
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

    it("routes user-machine-scoped-only to the user's aggregate machine room", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "account-settings-changed", settingsVersion: 2 }, createdAt: 0 } as any,
            recipientFilter: { type: "user-machine-scoped-only" },
        });

        expect(ioTo).toHaveBeenCalledWith("user-machines:u1");
        expect(emit).toHaveBeenCalledWith("update", expect.anything());
    });

    it("never emits per-account update containers to shared session/machine rooms", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit, except: () => ({ emit }) });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "update-machine" }, createdAt: 0 } as any,
            recipientFilter: { type: "machine-scoped-only", machineId: "m1" },
        });

        eventRouter.emitUpdate({
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

    it("records low-cardinality socket emission telemetry", () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit, except: () => ({ emit }) });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message", sessionId: "s1" }, createdAt: 0 } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        const labels = {
            event_name: "update",
            payload_type: "new-message",
            recipient_filter: "all-interested-in-session",
        };
        expect(socketEmissionsInc).toHaveBeenCalledWith(labels);
        expect(socketEmissionPayloadBytesObserve).toHaveBeenCalledWith(labels, expect.any(Number));
    });

    it("samples socket payload byte telemetry instead of measuring every emission", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit, except: () => ({ emit }) });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitEphemeral({
            userId: "u1",
            payload: { type: "transcript-stream-segment", sessionId: "s1", message: { accumulatedText: "x".repeat(100_000) } } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        expect(socketEmissionsInc).toHaveBeenCalledTimes(1);
        expect(socketEmissionPayloadBytesObserve).not.toHaveBeenCalled();
    });
});


describe('focused computer room query', () => {
    afterEach(() => eventRouter.clearIo());
    it('checks remote adapter socket data and excludes phone, daemon, legacy and blurred sockets', async () => {
        const fetchSockets = vi.fn().mockResolvedValue([
            { data: { clientType: 'user-scoped', clientPurpose: 'sync', uiFocus: { computer: false, focused: true } } },
            { data: { clientType: 'machine-scoped', clientPurpose: 'sync', uiFocus: { computer: true, focused: true } } },
            { data: { clientType: 'user-scoped', clientPurpose: 'sync' } },
            { data: { clientType: 'user-scoped', clientPurpose: 'sync', uiFocus: { computer: true, focused: false } } },
        ]);
        const inRoom = vi.fn(() => ({ fetchSockets }));
        // Boundary fixture: this query uses only the account-room socket-fetch API of Socket.IO.
        eventRouter.setIo({ in: inRoom } as any);
        expect(await eventRouter.hasFocusedComputerUi('account')).toBe(false);
        expect(inRoom).toHaveBeenCalledWith('user-scoped:account');
        fetchSockets.mockResolvedValue([{ data: { clientType: 'user-scoped', clientPurpose: 'sync', uiFocus: { computer: true, focused: true } } }]);
        expect(await eventRouter.hasFocusedComputerUi('account')).toBe(true);
        fetchSockets.mockRejectedValue(new Error('adapter unavailable'));
        expect(await eventRouter.hasFocusedComputerUi('account')).toBe(false);
    });
});
