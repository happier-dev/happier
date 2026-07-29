import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { queryUsageAnalytics } from "@/app/usage/usageQueryService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const { emitEphemeral, buildUsageEphemeral } = vi.hoisted(() => ({
    emitEphemeral: vi.fn(),
    buildUsageEphemeral: vi.fn(() => ({ type: "usage" })),
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn(), emitEphemeral },
    buildUsageEphemeral,
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("usageHandler", () => {
    let harness: LightSqliteHarness;
    let registerUsageHandler: (userId: string, socket: any, connection: any) => void;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-usage-socket-", initAuth: false });
        ({ usageHandler: registerUsageHandler } = await import("./usageHandler"));
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageEvent.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("preserves legacy websocket writes while mirroring deltas into usage analytics", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-socket-bridge" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-socket-bridge",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        const socket = createFakeSocket();
        registerUsageHandler(account.id, socket as any, { connectionType: "user-scoped", socket: socket as any, userId: account.id });
        const handler = getSocketHandler(socket, "usage-report");

        const firstCallback = vi.fn();
        await handler({
            key: "legacy-socket-k1",
            sessionId: session.id,
            tokens: { total: 10, input: 6, output: 4 },
            cost: { total: 0.1 },
        }, firstCallback);

        const secondCallback = vi.fn();
        await handler({
            key: "legacy-socket-k1",
            sessionId: session.id,
            tokens: { total: 15, input: 9, output: 6 },
            cost: { total: 0.15 },
        }, secondCallback);

        expect(firstCallback).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        expect(secondCallback).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

        const storedReport = await db.usageReport.findUnique({
            where: {
                accountId_sessionId_key: {
                    accountId: account.id,
                    sessionId: session.id,
                    key: "legacy-socket-k1",
                },
            },
            select: { data: true },
        });
        expect(storedReport).toEqual(expect.objectContaining({
            data: {
                tokens: { total: 15, input: 9, output: 6 },
                cost: { total: 0.15 },
            },
        }));

        const analytics = await queryUsageAnalytics(account.id, {
            granularity: "day",
            timeZoneOffsetMinutes: 0,
            includeSeries: true,
            topLimit: 20,
            filters: { sessionIds: [session.id] },
            breakdowns: ["source"],
        });
        expect(analytics).toMatchObject({
            v: 1,
            totals: {
                eventCount: 2,
                tokens: { total: 15, input: 9, output: 6 },
                cost: { reportedUsd: 0.15, estimatedUsd: 0, currency: "USD" },
            },
            breakdowns: {
                source: [
                    expect.objectContaining({
                        key: "legacy_usage_report",
                        eventCount: 2,
                        tokens: expect.objectContaining({ total: 15 }),
                    }),
                ],
            },
        });

        expect(buildUsageEphemeral).toHaveBeenNthCalledWith(
            1,
            session.id,
            "legacy-socket-k1",
            { total: 10, input: 6, output: 4 },
            { total: 0.1 },
        );
        expect(buildUsageEphemeral).toHaveBeenNthCalledWith(
            2,
            session.id,
            "legacy-socket-k1",
            { total: 15, input: 9, output: 6 },
            { total: 0.15 },
        );
        expect(emitEphemeral).toHaveBeenCalledTimes(2);
    });

    it("rejects session-scoped usage reports whose target session does not match the socket binding", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-socket-session-guard" },
            select: { id: true },
        });
        const targetSession = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-socket-session-guard-target",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        const socket = createFakeSocket({
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "s-bound",
                    machineId: null,
                    proof: "owner-session",
                },
            },
        });
        registerUsageHandler(account.id, socket as any, {
            connectionType: "session-scoped",
            socket: socket as any,
            userId: account.id,
            sessionId: "s-bound",
        });

        const callback = vi.fn();
        await getSocketHandler(socket, "usage-report")({
            key: "legacy-socket-cross-session",
            sessionId: targetSession.id,
            tokens: { total: 10 },
            cost: { total: 0.1 },
        }, callback);

        expect(callback).toHaveBeenCalledWith({ success: false, error: "Forbidden" });
        expect(await db.usageReport.count()).toBe(0);
        expect(await db.usageEvent.count()).toBe(0);
        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("does not throw when old clients omit the callback on invalid usage payloads", async () => {
        const socket = createFakeSocket();
        registerUsageHandler("user-1", socket as any, { connectionType: "user-scoped", socket: socket as any, userId: "user-1" });
        const handler = getSocketHandler(socket, "usage-report");

        await expect(handler({ key: "legacy-k1", tokens: { total: "bad" }, cost: { total: 1 } })).resolves.toBeUndefined();

        expect(await db.usageReport.count()).toBe(0);
        expect(await db.usageEvent.count()).toBe(0);
        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("rejects malformed nested legacy usage values before writing", async () => {
        const socket = createFakeSocket();
        registerUsageHandler("user-1", socket as any, { connectionType: "user-scoped", socket: socket as any, userId: "user-1" });
        const callback = vi.fn();

        await getSocketHandler(socket, "usage-report")({
            key: "legacy-k1",
            sessionId: "session-1",
            tokens: { total: 1, input: "not-a-number" },
            cost: { total: 1 },
        }, callback);

        expect(callback).toHaveBeenCalledWith({ success: false, error: "Invalid parameters" });
        expect(await db.usageReport.count()).toBe(0);
        expect(await db.usageEvent.count()).toBe(0);
    });
});
