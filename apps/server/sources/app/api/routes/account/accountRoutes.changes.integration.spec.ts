import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

const { emitUpdate, buildUpdateAccountUpdate, randomKeyNaked, markAccountChanged } = vi.hoisted(() => ({
    emitUpdate: vi.fn(),
    buildUpdateAccountUpdate: vi.fn((_userId: string, _profile: any, updSeq: number, updId: string) => ({
        id: updId,
        seq: updSeq,
        body: { t: "update-account" },
    })),
    randomKeyNaked: vi.fn(() => "upd-id"),
    markAccountChanged: vi.fn(async () => 444),
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildUpdateAccountUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("accountRoutes (AccountChange integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-changes-", initAuth: false });
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
            () => db.accountChange.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("marks account settings change and emits update using returned cursor", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pub",
                encryptionMode: "e2ee",
                settings: "old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { settings: "new", expectedVersion: 1 },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ success: true, version: 2 });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true },
        });
        expect(stored).toEqual({ settings: "new", settingsVersion: 2 });

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: account.id, kind: "account", entityId: "self" }),
        );

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: 444,
                    body: expect.objectContaining({ t: "update-account" }),
                }),
            }),
        );
    });
});
