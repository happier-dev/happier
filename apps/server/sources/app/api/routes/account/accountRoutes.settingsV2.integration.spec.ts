import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES } from "@happier-dev/protocol";

import {
    acquireAccountEncryptionTransitionFenceInTx,
    applyAccountEncryptionTransitionInTx,
} from "@/app/encryption/accountEncryptionTransition";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("accountRoutes (/v2/account/settings) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-settings-v2-",
            initAuth: false,
            sqliteConnectionLimit: 2,
        });
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

    it("does not commit an old-mode v2 Settings writer across the Account transition fence", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                seq: 41,
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const transitionFenceAcquired = deferred();
        const releaseTransition = deferred();
        let writerSettled = false;
        const transition = inTx(async (tx) => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, account.id);
            expect(fence.status).toBe("ready");
            if (fence.status !== "ready") return;
            transitionFenceAcquired.resolve();
            await releaseTransition.promise;
            await applyAccountEncryptionTransitionInTx(tx, {
                accountId: account.id,
                expectedVersion: fence.account.version,
                toMode: "plain",
                contentKey: { kind: "preserve" },
            });
        });

        await transitionFenceAcquired.promise;

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const writer = app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        content: { t: "encrypted", c: "old-mode-ciphertext" },
                        expectedVersion: 0,
                    },
                }).finally(() => {
                    writerSettled = true;
                });

                try {
                    // The route owns its own transaction, so this verifies that
                    // it cannot read or write stale E2EE settings while the
                    // transition owns the Account-first fence.
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    expect(writerSettled).toBe(false);

                    releaseTransition.resolve();
                    await transition;

                    const response = await writer;
                    expect(response.statusCode).toBe(400);
                    expect(response.json()).toEqual({ error: "invalid-params" });
                } finally {
                    releaseTransition.resolve();
                    await transition.catch(() => undefined);
                    await writer.catch(() => undefined);
                }
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                settings: true,
                settingsVersion: true,
            },
        })).resolves.toEqual({
            encryptionMode: "plain",
            settings: null,
            settingsVersion: 0,
        });
        await expect(db.accountSettingsSnapshot.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(db.accountChange.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    }, 30_000);

    it("returns the typed tooLarge result without writing for a semantically oversized V2 envelope", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true, settings: true, settingsVersion: true, updatedAt: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        content: {
                            t: "encrypted",
                            c: "x".repeat(ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES + 1),
                        },
                        expectedVersion: 0,
                    },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({
                    success: false,
                    error: "invalid",
                    reason: "tooLarge",
                });
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
        })).resolves.toBe(0);
        await expect(db.accountChange.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    });

    it("GET /v2/account/settings returns plain envelope for a plain account", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-get",
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { schemaVersion: 2, notificationsSettingsV1: { v: 1 } } }),
                settingsVersion: 3,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body).toEqual({
                    content: { t: "plain", v: expect.any(Object) },
                    version: 3,
                });
                expect(body.content.v.schemaVersion).toBe(2);
            },
        );
    });

    it("GET /v2/account/settings reports retained unreadable settings as storage unavailable", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-unreadable",
                encryptionMode: "plain",
                settings: "retained-e2ee-ciphertext",
                settingsVersion: 3,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(503);
                expect(res.json()).toEqual({ error: "account_settings_storage_unavailable" });
                expect(res.body).not.toContain("retained-e2ee-ciphertext");
            },
        );
    });

    it("GET /v2/account/settings reports server-sealed settings without server custody as storage unavailable", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-sealed-unavailable",
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "sealed_v1", c: "AQID" }),
                settingsVersion: 4,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(503);
                expect(res.json()).toEqual({ error: "account_settings_storage_unavailable" });
                expect(res.body).not.toContain("AQID");
            },
        );
    });

    it("POST /v2/account/settings preserves retained unreadable settings without writing", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-post-unreadable",
                encryptionMode: "plain",
                settings: "retained-e2ee-ciphertext",
                settingsVersion: 3,
            },
            select: { id: true, settings: true, settingsVersion: true, updatedAt: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        content: { t: "plain", v: { schemaVersion: 2 } },
                        expectedVersion: 3,
                    },
                });

                expect(res.statusCode).toBe(503);
                expect(res.json()).toEqual({ error: "account_settings_storage_unavailable" });
                expect(res.body).not.toContain("retained-e2ee-ciphertext");
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
        })).resolves.toBe(0);
    });

    it("POST /v2/account/settings reports unavailable server-sealing custody without writing", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "server_sealed",
        });
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-post-sealing-unavailable",
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { schemaVersion: 1 } }),
                settingsVersion: 2,
            },
            select: { id: true, settings: true, settingsVersion: true, updatedAt: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        content: { t: "plain", v: { schemaVersion: 2 } },
                        expectedVersion: 2,
                    },
                });

                expect(res.statusCode).toBe(503);
                expect(res.json()).toEqual({ error: "account_settings_storage_unavailable" });
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
        })).resolves.toBe(0);
    });

    it("POST /v1/account/settings fails fast for a plain account", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v1-plain",
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
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
                    payload: { settings: "ciphertext", expectedVersion: 0 },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "plain_account_requires_settings_v2" });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true },
        });
        expect(stored).toEqual({ settings: null, settingsVersion: 0 });
    });

    it("POST /v2/account/settings rejects encrypted content for plain accounts", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-plain",
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: { t: "encrypted", c: "ciphertext" }, expectedVersion: 0 },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "invalid-params" });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true },
        });
        expect(stored).toEqual({ settings: null, settingsVersion: 0 });
    });

    it("GET and POST /v2/account/settings reject inconsistent E2EE before disclosure or write", async () => {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const getResponse = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: {
                        "x-test-user-id": account.id,
                    },
                });
                expect(getResponse.statusCode).toBe(503);
                expect(getResponse.json()).toEqual({
                    error: "account_settings_storage_unavailable",
                });
                expect(getResponse.body).not.toContain("ciphertext");

                const postResponse = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: { t: "plain", v: {} }, expectedVersion: 1 },
                });

                expect(postResponse.statusCode).toBe(503);
                expect(postResponse.json()).toEqual({
                    error: "account_settings_storage_unavailable",
                });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true },
        });
        expect(stored).toEqual({ settings: "ciphertext", settingsVersion: 1 });
    });
});
