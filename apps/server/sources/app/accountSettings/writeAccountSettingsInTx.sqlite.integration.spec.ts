import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { eventRouter } from "@/app/events/eventRouter";
import { deriveAccountRemoteAlertPolicyV1 } from "@happier-dev/protocol";
import { PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

import { writeAccountSettingsInTx } from "./writeAccountSettingsInTx";

const emitUpdate = vi.hoisted(() => vi.fn());

vi.mock("@/app/events/connectionEventRouter", () => ({
    eventRouter: { emitUpdate },
}));

describe("writeAccountSettingsInTx (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-settings-write-",
            initAuth: false,
        });
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
            () => db.accountChange.deleteMany(),
            () => db.accountSettingsSnapshot.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("binds remote policy to the successful settings CAS and does not renew it for predecessor writes", async () => {
        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settingsVersion: 0 },
        });
        const policy = deriveAccountRemoteAlertPolicyV1({ sessionRemoteAlertsEnabled: true });
        const write = (expectedVersion: number, next: Parameters<typeof writeAccountSettingsInTx>[0]['next']) => inTx((tx) =>
            writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion, next }));
        expect(await write(0, { kind: "v2", content: { t: "encrypted", c: "first" }, remoteAlertPolicy: policy }))
            .toEqual({ status: "success", version: 1, remoteAlertPolicyStatus: 'current' });
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
            settingsVersion: 1, remoteAlertPolicy: { settingsVersion: 1, policy },
        });
        expect(await write(0, { kind: "v2", content: { t: "encrypted", c: "conflict" }, remoteAlertPolicy: null }))
            .toMatchObject({ status: "version_mismatch", currentVersion: 1 });
        await write(1, { kind: "v1", settings: "predecessor" });
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
            settingsVersion: 2, remoteAlertPolicy: { settingsVersion: 1, policy },
        });
        await write(2, { kind: "v2", content: { t: "encrypted", c: "opt-out" }, remoteAlertPolicy: null });
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
            settingsVersion: 3, remoteAlertPolicy: null,
        });
    });

    it("commits the Settings CAS, history, change cursor, and publications together", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "settings-before",
                settingsVersion: 6,
                seq: 12,
            },
            select: { id: true, updatedAt: true },
        });

        await expect(inTx((tx) => writeAccountSettingsInTx({
            tx,
            accountId: account.id,
            expectedVersion: 6,
            next: {
                kind: "v2",
                content: { t: "encrypted", c: "settings-after" },
            },
        }))).resolves.toEqual({ status: "success", version: 7, remoteAlertPolicyStatus: 'disabled' });

        const stored = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                settings: true,
                settingsVersion: true,
                seq: true,
                updatedAt: true,
            },
        });
        expect(stored).toMatchObject({
            settings: "settings-after",
            settingsVersion: 7,
            seq: 13,
        });
        expect(stored.updatedAt.getTime()).toBeGreaterThanOrEqual(account.updatedAt.getTime());
        await expect(db.accountSettingsSnapshot.findMany({
            where: { accountId: account.id },
            orderBy: { version: "asc" },
            select: {
                version: true,
                settingsDbValue: true,
                encryptionMode: true,
            },
        })).resolves.toEqual([
            {
                version: 6,
                settingsDbValue: "settings-before",
                encryptionMode: "e2ee",
            },
            {
                version: 7,
                settingsDbValue: "settings-after",
                encryptionMode: "e2ee",
            },
        ]);
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "account",
                    entityId: "self",
                },
            },
            select: { cursor: true, hint: true },
        })).resolves.toEqual({
            cursor: 13,
            hint: { settingsVersion: 7 },
        });
        expect(eventRouter.emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: account.id,
            payload: expect.objectContaining({ body: expect.objectContaining({
                t: 'account-settings-changed', settingsVersion: 7,
            }) }),
        }));
    });

    it("leaves Settings, history, changes, and publication unchanged when the composing transaction fails", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "settings-before",
                settingsVersion: 6,
                seq: 12,
            },
            select: { id: true, updatedAt: true },
        });
        const outerFailure = new Error("composed resource write failed");

        await expect(inTx(async (tx) => {
            const result = await writeAccountSettingsInTx({
                tx,
                accountId: account.id,
                expectedVersion: 6,
                next: {
                    kind: "v2",
                    content: { t: "encrypted", c: "settings-after" },
                },
            });
            expect(result).toEqual({ status: "success", version: 7, remoteAlertPolicyStatus: 'disabled' });
            throw outerFailure;
        })).rejects.toBe(outerFailure);

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                settings: true,
                settingsVersion: true,
                seq: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            settings: "settings-before",
            settingsVersion: 6,
            seq: 12,
            updatedAt: account.updatedAt,
        });
        await expect(db.accountSettingsSnapshot.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(db.accountChange.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        expect(eventRouter.emitUpdate).not.toHaveBeenCalled();
    });

    it("rolls back staged history and publication when the terminal Settings CAS loses its admitted version", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "settings-before",
                settingsVersion: 6,
                seq: 12,
            },
        });

        // A real persistence change after admission exercises the final CAS
        // independently of SQLite's single-writer transaction scheduling.
        await expect(inTx(async (tx) => {
            await writeAccountSettingsInTx({
                tx,
                accountId: account.id,
                expectedVersion: 6,
                next: { kind: "v2", content: { t: "encrypted", c: "settings-after" } },
            });
            await tx.account.update({
                where: { id: account.id },
                data: { settingsVersion: { increment: 1 } },
            });
        })).rejects.toMatchObject({
            name: "AccountSettingsPublicationConflict",
            result: { status: "version_mismatch", currentVersion: 7 },
        });

        await expect(db.account.findUniqueOrThrow({ where: { id: account.id } })).resolves.toMatchObject({
            settings: "settings-before", settingsVersion: 6, seq: 12,
        });
        expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        expect(eventRouter.emitUpdate).not.toHaveBeenCalled();
    });

    it("rechecks transferred catalog authority before publishing a new legacy Settings root", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST = "none";
        const account = await db.account.create({ data: {
            publicKey: null, encryptionMode: "plain", settings: null, settingsVersion: 0,
        } });

        await expect(inTx(async (tx) => {
            await writeAccountSettingsInTx({
                tx, accountId: account.id, expectedVersion: 0,
                next: { kind: "v2", content: { t: "plain", v: { providerSettingsV1: {} } } },
            });
            // A tombstone is retained catalog authority. A newly admitted
            // Settings root cannot become authoritative after this row exists.
            await tx.userKVStore.create({ data: {
                accountId: account.id, key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
                value: null, version: 0,
            } });
        })).rejects.toMatchObject({
            name: "AccountSettingsPublicationConflict", result: { status: "invalid_content" },
        });

        expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        await expect(db.account.findUniqueOrThrow({ where: { id: account.id } })).resolves.toMatchObject({
            settings: null, settingsVersion: 0,
        });
        expect(eventRouter.emitUpdate).not.toHaveBeenCalled();
    });
});
