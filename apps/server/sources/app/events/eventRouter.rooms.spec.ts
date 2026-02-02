import { afterEach, describe, expect, it, vi } from "vitest";

import { eventRouter } from "./eventRouter";

describe("eventRouter (rooms)", () => {
    afterEach(() => {
        eventRouter.clearIo();
    });

    it("throws when HAPPY_SOCKET_ROOMS_ONLY=1 and io is not initialized", () => {
        process.env.HAPPY_SOCKET_ROOMS_ONLY = "1";
        try {
            expect(() =>
                eventRouter.emitUpdate({
                    userId: "u1",
                    payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
                    recipientFilter: { type: "user-scoped-only" },
                }),
            ).toThrow(/HAPPY_SOCKET_ROOMS_ONLY=1/);
        } finally {
            delete process.env.HAPPY_SOCKET_ROOMS_ONLY;
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

    it("routes all-interested-in-session to per-account session room + user-scoped rooms (excluding other users)", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        expect(ioTo).toHaveBeenCalledWith(["session:s1:u1", "user-scoped:u1"]);
        expect(emit).toHaveBeenCalledWith("update", expect.anything());
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

    it("never emits per-account update containers to shared session/machine rooms", () => {
        const ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
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
});
