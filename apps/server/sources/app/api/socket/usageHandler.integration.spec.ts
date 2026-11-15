import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
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

    async function createSession(accountId: string, tag: string) {
        return await db.session.create({
            data: {
                accountId, tag, encryptionMode: "e2ee", metadata: "ciphertext", metadataVersion: 1,
                agentState: null, agentStateVersion: 0, seq: 0, pendingVersion: 0, pendingCount: 0, active: true,
            },
            select: { id: true },
        });
    }

    function usageEvent(sessionId: string, externalKey: string) {
        return {
            sessionId, observedAt: 1_000, agentId: "codex", source: "runtime", scope: "turn_delta", isCumulative: false,
            externalKey, modelId: "gpt-5.4", projectKey: "project-1", workspaceId: "workspace-1",
            tokens: { input: 6, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
            cost: { reportedUsd: 0.1, estimatedUsd: 0, currency: "USD" },
        };
    }

    it("records one v2 usage event per acknowledged Session-socket emit through the ingest owner", async () => {
        const account = await db.account.create({ data: { publicKey: "pk-usage-socket-v2" }, select: { id: true } });
        const session = await createSession(account.id, "usage-socket-v2");
        const socket = createFakeSocket({ data: { clientType: "session-scoped",
            sessionScopedBinding: { sessionId: session.id, machineId: null, proof: "owner-session" } } });
        registerUsageHandler(account.id, socket as any, {
            connectionType: "session-scoped", socket: socket as any, userId: account.id, sessionId: session.id,
        });

        const callback = vi.fn();
        await getSocketHandler(socket, "usage-event")(usageEvent(session.id, "turn-1"), callback);

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ success: true, eventId: expect.any(String) }));
        const rows = await db.usageEvent.findMany({ select: { sessionId: true, projectKey: true, workspaceId: true } });
        expect(rows).toEqual([{ sessionId: session.id, projectKey: "project-1", workspaceId: "workspace-1" }]);
    });

    it("refuses a Session-socket usage event naming another Session", async () => {
        const account = await db.account.create({ data: { publicKey: "pk-usage-socket-session-guard" }, select: { id: true } });
        const targetSession = await createSession(account.id, "usage-socket-session-guard-target");
        const socket = createFakeSocket({ data: { clientType: "session-scoped",
            sessionScopedBinding: { sessionId: "s-bound", machineId: null, proof: "owner-session" } } });
        registerUsageHandler(account.id, socket as any, {
            connectionType: "session-scoped", socket: socket as any, userId: account.id, sessionId: "s-bound",
        });

        const callback = vi.fn();
        await getSocketHandler(socket, "usage-event")(usageEvent(targetSession.id, "cross-session"), callback);

        expect(callback).toHaveBeenCalledWith({ success: false, error: "Forbidden" });
        expect(await db.usageEvent.count()).toBe(0);
    });

    it("rejects malformed usage events before writing, with or without a callback", async () => {
        const socket = createFakeSocket();
        registerUsageHandler("user-1", socket as any, { connectionType: "user-scoped", socket: socket as any, userId: "user-1" });
        const handler = getSocketHandler(socket, "usage-event");
        const callback = vi.fn();

        await handler({ ...usageEvent("session-1", "bad"), tokens: { total: "bad" } }, callback);
        await expect(handler({ sessionId: "session-1" })).resolves.toBeUndefined();

        expect(callback).toHaveBeenCalledWith({ success: false, error: "Invalid parameters" });
        expect(await db.usageEvent.count()).toBe(0);
    });
});
