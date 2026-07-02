import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

const encryptedContent = (value: string) => ({ t: "encrypted" as const, c: value });

describe("accountRoutes (/v2/account/settings/history) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-settings-history-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
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

    it("stores previous and current encrypted snapshots after a v2 write", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-v2",
                encryptionMode: "e2ee",
                settings: "ciphertext-old",
                settingsVersion: 4,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const update = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: encryptedContent("ciphertext-new"), expectedVersion: 4 },
                });
                expect(update.statusCode).toBe(200);
                expect(update.json()).toEqual({ success: true, version: 5 });

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json()).toEqual({
                    snapshots: [
                        expect.objectContaining({ version: 5, contentKind: "encrypted", byteLength: "ciphertext-new".length }),
                        expect.objectContaining({ version: 4, contentKind: "encrypted", byteLength: "ciphertext-old".length }),
                    ],
                });
                expect(JSON.stringify(history.json())).not.toContain("ciphertext-new");
                expect(JSON.stringify(history.json())).not.toContain("ciphertext-old");
            },
        );
    });

    it("does not create history snapshots for failed v2 version checks", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-v2-cas",
                encryptionMode: "e2ee",
                settings: "ciphertext-current",
                settingsVersion: 7,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const update = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: encryptedContent("ciphertext-wrong"), expectedVersion: 6 },
                });
                expect(update.statusCode).toBe(200);
                expect(update.json()).toMatchObject({ success: false, error: "version-mismatch", currentVersion: 7 });

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json()).toEqual({ snapshots: [] });
            },
        );
    });

    it("stores previous and current encrypted snapshots after a v1 write", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-v1",
                encryptionMode: "e2ee",
                settings: "v1-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const update = await app.inject({
                    method: "POST",
                    url: "/v1/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { settings: "v1-new", expectedVersion: 1 },
                });
                expect(update.statusCode).toBe(200);
                expect(update.json()).toEqual({ success: true, version: 2 });

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json()).toEqual({
                    snapshots: [
                        expect.objectContaining({ version: 2, contentKind: "encrypted" }),
                        expect.objectContaining({ version: 1, contentKind: "encrypted" }),
                    ],
                });
            },
        );
    });

    it("prunes history snapshots to the configured limit", async () => {
        harness.resetEnv({ HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: "2" });
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-prune",
                encryptionMode: "e2ee",
                settings: "ciphertext-0",
                settingsVersion: 0,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                for (let version = 0; version < 4; version += 1) {
                    const update = await app.inject({
                        method: "POST",
                        url: "/v2/account/settings",
                        headers: { "content-type": "application/json", "x-test-user-id": account.id },
                        payload: { content: encryptedContent(`ciphertext-${version + 1}`), expectedVersion: version },
                    });
                    expect(update.statusCode).toBe(200);
                    expect(update.json()).toEqual({ success: true, version: version + 1 });
                }

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json().snapshots.map((snapshot: { version: number }) => snapshot.version)).toEqual([4, 3]);
            },
        );
    });

    it("does not retain history snapshots when the configured limit is zero", async () => {
        harness.resetEnv({ HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: "0" });
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-disabled",
                encryptionMode: "e2ee",
                settings: "disabled-old",
                settingsVersion: 0,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const update = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: encryptedContent("disabled-new"), expectedVersion: 0 },
                });
                expect(update.statusCode).toBe(200);
                expect(update.json()).toEqual({ success: true, version: 1 });

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json()).toEqual({ snapshots: [] });
            },
        );
    });

    it("returns snapshot content only from the version detail route", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-detail",
                encryptionMode: "e2ee",
                settings: "detail-old",
                settingsVersion: 10,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: encryptedContent("detail-new"), expectedVersion: 10 },
                });

                const detail = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history/10",
                    headers: { "x-test-user-id": account.id },
                });
                expect(detail.statusCode).toBe(200);
                expect(detail.json()).toEqual({
                    content: encryptedContent("detail-old"),
                    version: 10,
                    createdAt: expect.any(String),
                });
            },
        );
    });

    it("restores a client-validated encrypted snapshot as a new current version", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-restore",
                encryptionMode: "e2ee",
                settings: "restore-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: encryptedContent("restore-new"), expectedVersion: 1 },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 2, content: encryptedContent("restore-old") },
                });
                expect(restore.statusCode).toBe(200);
                expect(restore.json()).toEqual({ success: true, version: 3 });

                const current = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });
                expect(current.json()).toEqual({ content: encryptedContent("restore-old"), version: 3 });
            },
        );
    });

    it("rejects restore when the client-validated content echo is missing", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-restore-missing-echo",
                encryptionMode: "e2ee",
                settings: "restore-missing-echo-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: encryptedContent("restore-missing-echo-new"), expectedVersion: 1 },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 2 },
                });
                expect(restore.statusCode).toBe(400);

                const current = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });
                expect(current.json()).toEqual({ content: encryptedContent("restore-missing-echo-new"), version: 2 });
            },
        );
    });

    it("rejects restore when the client-validated content does not match the snapshot", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-restore-validation",
                encryptionMode: "e2ee",
                settings: "restore-validated-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: encryptedContent("restore-validated-new"), expectedVersion: 1 },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 2, content: encryptedContent("wrong-ciphertext") },
                });
                expect(restore.statusCode).toBe(400);
                expect(restore.json()).toEqual({ error: "invalid-params" });

                const current = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });
                expect(current.json()).toEqual({ content: encryptedContent("restore-validated-new"), version: 2 });
            },
        );
    });

    it("rejects restore when the snapshot storage mode is incompatible with the current account mode", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-restore-mode",
                encryptionMode: "e2ee",
                settings: "restore-mode-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: encryptedContent("restore-mode-new"), expectedVersion: 1 },
                });

                await db.account.update({
                    where: { id: account.id },
                    data: { encryptionMode: "plain" },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 2, content: encryptedContent("restore-mode-old") },
                });
                expect(restore.statusCode).toBe(400);
                expect(restore.json()).toEqual({ error: "invalid-params" });

                const stored = await db.account.findUnique({
                    where: { id: account.id },
                    select: { settings: true, settingsVersion: true },
                });
                expect(stored).toEqual({ settings: "restore-mode-new", settingsVersion: 2 });
            },
        );
    });

    it("returns a CAS mismatch when restore expectedVersion is stale", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-restore-cas",
                encryptionMode: "e2ee",
                settings: "restore-cas-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: encryptedContent("restore-cas-new"), expectedVersion: 1 },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 1, content: encryptedContent("restore-cas-old") },
                });
                expect(restore.statusCode).toBe(200);
                expect(restore.json()).toEqual({ success: false, error: "version-mismatch", currentVersion: 2 });
            },
        );
    });
});
