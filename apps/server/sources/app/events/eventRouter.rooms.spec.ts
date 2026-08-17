import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { register } from "@/app/monitoring/metrics/registry";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { eventRouter } from "./eventRouter";

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
    });

    afterEach(() => {
        eventRouter.clearIo();
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

    it("records room fanout target counts for room-based dispatch", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const ioTo = vi.fn().mockReturnValue({ emit: vi.fn() });
        eventRouter.setIo({ to: ioTo } as any);

        eventRouter.emitUpdate({
            userId: "u1",
            payload: { id: "x", seq: 1, body: { t: "new-message" }, createdAt: 0 } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        const samples = await readMetricSamples("event_fanout_emits_total");
        expect(samples).toContainEqual({
            labels: {
                dispatch_mode: "room",
                event_name: "update",
                filter_type: "all-interested-in-session",
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
                        filter_type: "all-interested-in-session",
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

        eventRouter.emitEphemeral({
            userId: "u1",
            payload: {
                type: "transcript-stream-segment",
                sessionId: "s1",
                message: { accumulatedText: "x".repeat(100_000) },
            } as any,
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        });

        const emitSamples = await readMetricSamples("event_fanout_emits_total");
        expect(emitSamples).toContainEqual({
            labels: {
                dispatch_mode: "room",
                event_name: "ephemeral",
                filter_type: "all-interested-in-session",
            },
            value: 1,
        });
        expect(await readMetricSamples("event_fanout_payload_bytes")).toEqual([]);
    });
});
