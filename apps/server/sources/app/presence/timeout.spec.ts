import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

const { emitEphemeral, emitUpdate, expireSessionPublisherCandidates, refreshSessionParticipantBadgePushes } = vi.hoisted(() => ({
    emitEphemeral: vi.fn(),
    emitUpdate: vi.fn(),
    expireSessionPublisherCandidates: vi.fn(),
    refreshSessionParticipantBadgePushes: vi.fn(),
}));
const dbMocks = createDbMocks({
    session: ["findMany", "updateMany", "updateManyAndReturn"],
    machine: ["findMany", "updateMany", "updateManyAndReturn"],
} as const);

installDbModuleMock({ db: dbMocks.db });

vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return {
        ...actual,
        eventRouter: {
            ...actual.eventRouter,
            emitEphemeral,
            emitUpdate,
        },
    };
});

vi.mock("./sessionPublisherPresence", () => ({ expireSessionPublisherCandidates }));
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({ refreshSessionParticipantBadgePushes }));

vi.mock("@/utils/logging/log", () => ({ warn: vi.fn(), log: vi.fn() }));

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:20:00.000Z"));
    dbMocks.reset();
    dbMocks.db.session.findMany.mockResolvedValue([]);
    dbMocks.db.machine.findMany.mockResolvedValue([]);
    dbMocks.db.session.updateMany.mockResolvedValue({ count: 0 });
    dbMocks.db.machine.updateMany.mockResolvedValue({ count: 0 });
    dbMocks.db.session.updateManyAndReturn.mockResolvedValue([]);
    dbMocks.db.machine.updateManyAndReturn.mockResolvedValue([]);
    expireSessionPublisherCandidates.mockReset();
    expireSessionPublisherCandidates.mockResolvedValue([]);
    refreshSessionParticipantBadgePushes.mockReset();
    refreshSessionParticipantBadgePushes.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
});

async function importTimeoutModule(): Promise<typeof import("./timeout")> {
    return await import("./timeout");
}

describe("presence timeout config", () => {
    it("uses default timeouts when env unset", async () => {
        const { resolvePresenceTimeoutConfig } = await importTimeoutModule();
        const config = resolvePresenceTimeoutConfig({});
        expect(config).toEqual({
            sessionTimeoutMs: 10 * 60 * 1000,
            machineTimeoutMs: 10 * 60 * 1000,
            tickMs: 60 * 1000,
        });
    });

    it("accepts env overrides", async () => {
        const { resolvePresenceTimeoutConfig } = await importTimeoutModule();
        const config = resolvePresenceTimeoutConfig({
            HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: "35000",
            HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: "45000",
            HAPPIER_PRESENCE_TIMEOUT_TICK_MS: "1000",
        });
        expect(config).toEqual({ sessionTimeoutMs: 35_000, machineTimeoutMs: 45_000, tickMs: 1_000 });
    });

    it("falls back when env is invalid", async () => {
        const { resolvePresenceTimeoutConfig } = await importTimeoutModule();
        const config = resolvePresenceTimeoutConfig({
            HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: "nope",
            HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: "0",
            HAPPIER_PRESENCE_TIMEOUT_TICK_MS: "-1",
        });
        expect(config).toEqual({
            sessionTimeoutMs: 10 * 60 * 1000,
            machineTimeoutMs: 10 * 60 * 1000,
            tickMs: 60 * 1000,
        });
    });
});

describe("runPresenceTimeoutTick", () => {
    const config = {
        sessionTimeoutMs: 10 * 60 * 1000,
        machineTimeoutMs: 10 * 60 * 1000,
        tickMs: 60 * 1000,
    };

    it("delegates exact session expiry and disseminates every committed participant cursor once", async () => {
        const { runPresenceTimeoutTick } = await importTimeoutModule();
        const oldActiveAt = new Date("2026-01-01T00:00:00.000Z");
        dbMocks.db.session.findMany.mockResolvedValue([
            { id: "s1", accountId: "u1", lastActiveAt: oldActiveAt },
            { id: "s2", accountId: "u2", lastActiveAt: oldActiveAt },
        ]);
        expireSessionPublisherCandidates.mockResolvedValue([
            {
                status: "expired",
                sessionId: "s1",
                activeAt: oldActiveAt,
                participantCursors: [
                    { accountId: "u1", cursor: 101 },
                    { accountId: "u3", cursor: 103 },
                ],
                badgeAttentionChanged: true,
            },
            { status: "stale", sessionId: "s2" },
        ]);

        await runPresenceTimeoutTick(config);

        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
        expect(expireSessionPublisherCandidates).toHaveBeenCalledWith({
            candidates: [
                { sessionId: "s1", observedFence: oldActiveAt },
                { sessionId: "s2", observedFence: oldActiveAt },
            ],
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u3",
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        }));
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledTimes(1);
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledWith({
            badgeAttentionChanged: true,
            participantCursors: [
                { accountId: "u1", cursor: 101 },
                { accountId: "u3", cursor: 103 },
            ],
        });
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
        expect(emitEphemeral).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                userId: "u1",
                payload: expect.objectContaining({ type: "activity", id: "s1", active: false }),
            }),
        );
    });

    it("marks timed-out machines inactive only through their exact scanned fences", async () => {
        const { runPresenceTimeoutTick } = await importTimeoutModule();
        const oldActiveAt = new Date("2026-01-01T00:00:00.000Z");
        dbMocks.db.machine.findMany.mockResolvedValue([
            { id: "m1", accountId: "u1", lastActiveAt: oldActiveAt },
            { id: "m2", accountId: "u2", lastActiveAt: oldActiveAt },
        ]);
        dbMocks.db.machine.updateMany.mockResolvedValue({ count: 1 });

        await runPresenceTimeoutTick(config);

        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledTimes(2);
        expect(dbMocks.db.machine.updateMany).toHaveBeenNthCalledWith(1, {
            where: { id: "m1", active: true, lastActiveAt: oldActiveAt },
            data: { active: false },
        });
        expect(emitEphemeral).toHaveBeenCalledTimes(2);
        expect(emitEphemeral).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                userId: "u1",
                payload: expect.objectContaining({ type: "machine-activity", id: "m1", active: false }),
            }),
        );
    });

    it("lets the next tick retry after a transient P2024 failure", async () => {
        const { runPresenceTimeoutTick } = await importTimeoutModule();
        const oldActiveAt = new Date("2026-01-01T00:00:00.000Z");
        dbMocks.db.session.findMany.mockResolvedValue([{ id: "s1", accountId: "u1", lastActiveAt: oldActiveAt }]);
        expireSessionPublisherCandidates
            .mockRejectedValueOnce(Object.assign(new Error("pool exhausted"), { code: "P2024" }))
            .mockResolvedValueOnce([{
                status: "expired",
                sessionId: "s1",
                activeAt: oldActiveAt,
                participantCursors: [{ accountId: "u1", cursor: 101 }],
                badgeAttentionChanged: false,
            }]);

        await runPresenceTimeoutTick(config);
        await runPresenceTimeoutTick(config);

        expect(expireSessionPublisherCandidates).toHaveBeenCalledTimes(2);
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
    });

    it("does not clear a replacement fence discovered after the timeout scan", async () => {
        const { runPresenceTimeoutTick } = await importTimeoutModule();
        const oldActiveAt = new Date("2026-01-01T00:00:00.000Z");
        dbMocks.db.session.findMany.mockResolvedValue([
            { id: "s1", accountId: "u1", lastActiveAt: oldActiveAt },
            { id: "s2", accountId: "u2", lastActiveAt: oldActiveAt },
        ]);
        expireSessionPublisherCandidates.mockResolvedValue([
            { status: "stale", sessionId: "s1" },
            {
                status: "expired",
                sessionId: "s2",
                activeAt: oldActiveAt,
                participantCursors: [{ accountId: "u2", cursor: 202 }],
                badgeAttentionChanged: false,
            },
        ]);

        await runPresenceTimeoutTick(config);

        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({ userId: "u2" }));
    });
});
