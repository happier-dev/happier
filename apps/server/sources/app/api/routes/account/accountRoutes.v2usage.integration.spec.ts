import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

const { emitEphemeral, buildUsageEphemeral } = vi.hoisted(() => ({
    emitEphemeral: vi.fn(),
    buildUsageEphemeral: vi.fn(() => ({ type: "usage" })),
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn(), emitEphemeral },
    buildUpdateAccountUpdate: vi.fn(),
    buildUsageEphemeral,
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("accountRoutes v2 usage", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-usage-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("upserts usage report and emits ephemeral when sessionId is provided", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-upsert" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-session",
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

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "k1",
                        sessionId: session.id,
                        tokens: { total: 10, prompt: 5 },
                        cost: { total: 0.1 },
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toMatchObject({
                    success: true,
                    reportId: expect.any(String),
                    createdAt: expect.any(Number),
                    updatedAt: expect.any(Number),
                });
            },
        );

        const stored = await db.usageReport.findUnique({
            where: {
                accountId_sessionId_key: {
                    accountId: account.id,
                    sessionId: session.id,
                    key: "k1",
                },
            },
            select: { id: true, data: true },
        });
        expect(stored).toEqual(
            expect.objectContaining({
                id: expect.any(String),
                data: { tokens: { total: 10, prompt: 5 }, cost: { total: 0.1 } },
            }),
        );
        expect(buildUsageEphemeral).toHaveBeenCalledWith(session.id, "k1", { total: 10, prompt: 5 }, { total: 0.1 });
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when sessionId does not belong to user", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-missing-session" },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { key: "k1", sessionId: "missing-session", tokens: { total: 1 }, cost: { total: 1 } },
                });

                expect(res.statusCode).toBe(404);
                expect(res.json()).toEqual({ error: "Session not found" });
            },
        );

        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(await db.usageReport.count()).toBe(0);
    });
});
