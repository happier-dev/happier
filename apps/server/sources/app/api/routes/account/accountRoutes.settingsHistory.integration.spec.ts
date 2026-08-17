import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

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
                ...createSignedAccountContentBinding(),
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
                ...createSignedAccountContentBinding(),
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
                ...createSignedAccountContentBinding(),
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
                ...createSignedAccountContentBinding(),
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
                ...createSignedAccountContentBinding(),
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
                ...createSignedAccountContentBinding(),
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

    it("fails an unknown snapshot mode without exposing bytes, cursors, or a restore mutation", async () => {
        const retainedBytes = "retained-unknown-mode-settings-bytes";
        const account = await db.account.create({
            data: {
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { schemaVersion: 2 } }),
                settingsVersion: 3,
            },
            select: { id: true, settings: true, settingsVersion: true, updatedAt: true },
        });
        await db.accountSettingsSnapshot.create({
            data: {
                accountId: account.id,
                version: 2,
                settingsDbValue: retainedBytes,
                encryptionMode: "future-mode",
                contentKind: "encrypted",
            },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const list = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(list.statusCode).toBe(503);
                expect(list.json()).toEqual({ error: "account_settings_storage_unavailable" });
                expect(list.body).not.toContain(retainedBytes);

                const detail = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history/2",
                    headers: { "x-test-user-id": account.id },
                });
                expect(detail.statusCode).toBe(503);
                expect(detail.json()).toEqual({ error: "account_settings_storage_unavailable" });
                expect(detail.body).not.toContain(retainedBytes);

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/2/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        expectedVersion: 3,
                        content: encryptedContent(retainedBytes),
                    },
                });
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });
                expect(restore.body).not.toContain(retainedBytes);
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true, updatedAt: true },
        })).resolves.toEqual({
            settings: account.settings,
            settingsVersion: account.settingsVersion,
            updatedAt: account.updatedAt,
        });
        await expect(db.accountSettingsSnapshot.count({
            where: { accountId: account.id },
        })).resolves.toBe(1);
        await expect(db.accountChange.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    });

    it("reports an unreadable plain snapshot as storage unavailable without exposing retained bytes", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-detail-unreadable",
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { schemaVersion: 2 } }),
                settingsVersion: 3,
            },
            select: { id: true },
        });
        await db.accountSettingsSnapshot.create({
            data: {
                accountId: account.id,
                version: 2,
                settingsDbValue: "retained-e2ee-history-ciphertext",
                encryptionMode: "plain",
                contentKind: "plain",
            },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const detail = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history/2",
                    headers: { "x-test-user-id": account.id },
                });

                expect(detail.statusCode).toBe(503);
                expect(detail.json()).toEqual({ error: "account_settings_storage_unavailable" });
                expect(detail.body).not.toContain("retained-e2ee-history-ciphertext");
            },
        );
    });

    it("refuses to restore an unreadable plain snapshot without writing", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-restore-unreadable",
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { schemaVersion: 2 } }),
                settingsVersion: 3,
            },
            select: { id: true, settings: true, settingsVersion: true, updatedAt: true },
        });
        await db.accountSettingsSnapshot.create({
            data: {
                accountId: account.id,
                version: 2,
                settingsDbValue: "retained-e2ee-history-ciphertext",
                encryptionMode: "plain",
                contentKind: "plain",
            },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/2/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        expectedVersion: 3,
                        content: { t: "plain", v: { schemaVersion: 2 } },
                    },
                });

                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });
                expect(restore.body).not.toContain("retained-e2ee-history-ciphertext");
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true, updatedAt: true },
        })).resolves.toEqual({
            settings: account.settings,
            settingsVersion: account.settingsVersion,
            updatedAt: account.updatedAt,
        });
        await expect(db.accountSettingsSnapshot.count({
            where: { accountId: account.id },
        })).resolves.toBe(1);
    });

    it("fails closed instead of letting the retired exact-content restore overwrite current encrypted settings", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
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
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });

                const current = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });
                expect(current.json()).toEqual({ content: encryptedContent("restore-new"), version: 2 });
            },
        );
    });

    it("rejects restore when the client-validated content echo is missing", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
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
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });

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
                ...createSignedAccountContentBinding(),
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
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });

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
                ...createSignedAccountContentBinding(),
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
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });

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
                ...createSignedAccountContentBinding(),
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
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });
            },
        );
    });
});
