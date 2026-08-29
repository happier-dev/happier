import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { deleteAccountForErasure } from "@/app/plugins/data/accountDataErase";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const NOW = new Date("2026-08-10T09:00:00.000Z");
const TOMBSTONE_EXPIRES_AT = new Date("2026-08-17T09:00:00.000Z");

function randomEndpointId(): string {
    return `wh_ep_${Buffer.from(randomUUID().replace(/-/gu, ""), "hex").toString("base64url")}`;
}

describe("plugin webhook Account-deletion cleanup", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-webhook-account-delete-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS prevent_account_erasure");
        await harness?.resetDbTables([
            () => db.pluginWebhookDelivery.deleteMany(),
            () => db.pluginWebhookEndpointOperation.deleteMany(),
            () => db.pluginWebhookEndpoint.deleteMany(),
            () => db.pluginWebhookCredential.deleteMany(),
            () => db.pluginWebhookRoute.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("purges Account-owned custody and leaves only a detached shared-route replay tombstone", async () => {
        const suffix = randomUUID();
        const accountId = `webhook-delete-${suffix}`;
        const accountEndpointId = randomEndpointId();
        const sharedEndpointId = randomEndpointId();

        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        const accountRoute = await db.pluginWebhookRoute.create({
            data: {
                opaqueRouteId: `opaque-account-${suffix}`,
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
            },
        });
        const sharedRouteRecord = await db.pluginWebhookRoute.create({
            data: {
                opaqueRouteId: `opaque-shared-${suffix}`,
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "providerInstallation",
                operatorPluginId: `happier.github.${suffix}`,
                operatorWebhookContributionId: "github-events",
            },
        });
        const accountRouteId = accountRoute.id;
        const sharedRouteId = sharedRouteRecord.id;
        await db.pluginWebhookEndpoint.create({
            data: {
                id: accountEndpointId,
                accountId,
                pluginId: "happier.github",
                webhookContributionId: "github-events",
                handlerActionId: "channels/webhook-receive-v1",
                sourceInstanceId: `account-source-${suffix}`,
                ensureIdempotencyKey: `account-idempotency-${suffix}`,
                ensureRequestFingerprint: "a".repeat(64),
                setupKind: "accountEndpointV1",
                routeId: accountRouteId,
                routingKind: "accountEndpoint",
                targetMachineId: "machine-account",
                targetMachineInstallationId: "installation-account",
                targetMaterializationId: "materialization-account",
                targetPluginVersion: "1.0.0",
            },
        });
        await db.pluginWebhookRoute.update({
            where: { id: accountRouteId },
            data: { accountEndpointId },
        });
        await db.pluginWebhookEndpoint.create({
            data: {
                id: sharedEndpointId,
                accountId,
                pluginId: "happier.github",
                webhookContributionId: "github-events",
                handlerActionId: "channels/webhook-receive-v1",
                sourceInstanceId: `installation-source-${suffix}`,
                ensureIdempotencyKey: `shared-idempotency-${suffix}`,
                ensureRequestFingerprint: "b".repeat(64),
                setupKind: "githubSharedInstallationV1",
                routeId: sharedRouteId,
                routingKind: "providerInstallation",
                providerInstallationId: "123456789",
                targetMachineId: "machine-shared",
                targetMachineInstallationId: "installation-shared",
                targetMaterializationId: "materialization-shared",
                targetPluginVersion: "1.0.0",
                previousTargetMachineId: "machine-previous",
                previousTargetMachineInstallationId: "installation-previous",
                previousTargetMaterializationId: "materialization-previous",
                previousTargetPluginVersion: "0.9.0",
            },
        });

        for (const [routeId, endpointId, marker] of [
            [accountRouteId, accountEndpointId, "a"],
            [sharedRouteId, sharedEndpointId, "b"],
        ] as const) {
            const credential = await db.pluginWebhookCredential.create({
                data: {
                    routeId,
                    credentialVersionId: `credential-${marker}-${suffix}`,
                    verifierKind: "github_hmac_sha256_v1",
                    encryptedSecret: Buffer.from(`secret-${marker}`),
                    state: "current",
                },
            });
            await db.pluginWebhookRoute.update({
                where: { id: routeId },
                data: { currentCredentialId: credential.id },
            });
            await db.pluginWebhookEndpointOperation.create({
                data: {
                    accountId,
                    endpointId,
                    operationKind: "revoke",
                    idempotencyKey: `operation-${marker}-${suffix}`,
                    expectedRevision: 1,
                    resultKind: "revoked",
                    resultRevision: 2,
                },
            });
            await db.pluginWebhookDelivery.create({
                data: {
                    endpointId,
                    accountId,
                    routeId,
                    deliveryIdentityDigest: marker.repeat(64),
                    verifierKind: "github_hmac_sha256_v1",
                    targetMachineId: `machine-${marker}`,
                    targetMachineInstallationId: `installation-${marker}`,
                    targetMaterializationId: `materialization-${marker}`,
                    targetPluginId: "happier.github",
                    targetPluginVersion: "1.0.0",
                    endpointRevision: 1,
                    endpointWebhookContributionId: "github-events",
                    endpointHandlerActionId: "channels/webhook-receive-v1",
                    endpointSourceInstanceId: marker === "a"
                        ? `account-source-${suffix}`
                        : `installation-source-${suffix}`,
                    payloadKind: "plain",
                    payload: { t: "plain", v: { marker } },
                    payloadBytes: 1n,
                    wireVersion: 1,
                    payloadVersion: 1,
                    state: "queued",
                    nextAttemptAt: NOW,
                    metadataDeleteAt: TOMBSTONE_EXPIRES_AT,
                    receivedAt: NOW,
                },
            });
        }

        await expect(deleteAccountForErasure({ accountId, now: NOW })).resolves.toEqual({ status: "deleted" });
        expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
        expect(await db.pluginWebhookRoute.findUnique({ where: { id: accountRouteId } })).toBeNull();
        expect(await db.pluginWebhookEndpoint.findUnique({ where: { id: accountEndpointId } })).toBeNull();

        const sharedRoute = await db.pluginWebhookRoute.findUniqueOrThrow({
            where: { id: sharedRouteId },
            include: { credentials: true },
        });
        expect(sharedRoute.enabled).toBe(true);
        expect(sharedRoute.credentials).toHaveLength(1);
        expect(Buffer.from(sharedRoute.credentials[0]!.encryptedSecret).toString()).toBe("secret-b");

        const tombstone = await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: sharedEndpointId } });
        expect(tombstone).toMatchObject({
            id: sharedEndpointId,
            accountId: null,
            pluginId: null,
            webhookContributionId: null,
            handlerActionId: null,
            sourceInstanceId: null,
            ensureIdempotencyKey: null,
            ensureRequestFingerprint: null,
            setupKind: null,
            routeId: sharedRouteId,
            routingKind: "providerInstallation",
            providerInstallationId: "123456789",
            enabled: false,
            revision: 2,
            revokedAt: null,
            releasedAt: NOW,
            tombstoneExpiresAt: TOMBSTONE_EXPIRES_AT,
            targetMachineId: null,
            targetMachineInstallationId: null,
            targetMaterializationId: null,
            targetPluginVersion: null,
            previousTargetMachineId: null,
            previousTargetMachineInstallationId: null,
            previousTargetMaterializationId: null,
            previousTargetPluginVersion: null,
        });
        expect(await db.pluginWebhookDelivery.count({ where: { accountId } })).toBe(0);
        expect(await db.pluginWebhookEndpointOperation.count({ where: { accountId } })).toBe(0);

        // A response can be lost after the transaction commits. A retry must not revive the
        // deleted Account or touch the retained replay-isolation tombstone.
        await expect(deleteAccountForErasure({ accountId, now: NOW })).resolves.toEqual({ status: "already-deleted" });

        const reboundAccountId = `webhook-rebind-${suffix}`;
        await db.account.create({ data: { id: reboundAccountId, encryptionMode: "plain" } });
        await expect(db.pluginWebhookEndpoint.create({
            data: {
                id: randomEndpointId(),
                accountId: reboundAccountId,
                pluginId: "happier.github",
                webhookContributionId: "github-events",
                handlerActionId: "channels/webhook-receive-v1",
                sourceInstanceId: `rebind-source-${suffix}`,
                ensureIdempotencyKey: `rebind-idempotency-${suffix}`,
                ensureRequestFingerprint: "c".repeat(64),
                setupKind: "githubSharedInstallationV1",
                routeId: sharedRouteId,
                routingKind: "providerInstallation",
                providerInstallationId: "123456789",
                targetMachineId: "machine-rebind",
                targetMachineInstallationId: "installation-rebind",
                targetMaterializationId: "materialization-rebind",
                targetPluginVersion: "1.0.0",
            },
        })).rejects.toThrow();
    });

    it("rolls back all cleanup on terminal Account failure, then deletes Machine custody on retry", async () => {
        const suffix = randomUUID();
        const accountId = `webhook-delete-rollback-${suffix}`;
        const sharedEndpointId = randomEndpointId();

        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        const sharedRoute = await db.pluginWebhookRoute.create({
            data: {
                opaqueRouteId: `opaque-shared-rollback-${suffix}`,
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "providerInstallation",
                operatorPluginId: `happier.github.rollback.${suffix}`,
                operatorWebhookContributionId: "github-events",
            },
        });
        const sharedRouteId = sharedRoute.id;
        await db.pluginWebhookEndpoint.create({
            data: {
                id: sharedEndpointId,
                accountId,
                pluginId: "happier.github",
                webhookContributionId: "github-events",
                handlerActionId: "channels/webhook-receive-v1",
                sourceInstanceId: `rollback-source-${suffix}`,
                ensureIdempotencyKey: `rollback-idempotency-${suffix}`,
                ensureRequestFingerprint: "d".repeat(64),
                setupKind: "githubSharedInstallationV1",
                routeId: sharedRouteId,
                routingKind: "providerInstallation",
                providerInstallationId: "223456789",
                targetMachineId: "machine-rollback",
                targetMachineInstallationId: "installation-rollback",
                targetMaterializationId: "materialization-rollback",
                targetPluginVersion: "1.0.0",
            },
        });
        await db.machine.create({
            data: {
                id: `machine-rollback-${suffix}`,
                accountId,
                metadata: "fixture",
            },
        });

        await db.$executeRawUnsafe(`
            CREATE TRIGGER prevent_account_erasure
            BEFORE DELETE ON Account
            WHEN OLD.id = '${accountId}'
            BEGIN
                SELECT RAISE(ABORT, 'injected account deletion failure');
            END
        `);
        // The injected RAISE(ABORT) is the sole failure source here: the erase
        // already removed every RESTRICT child (machine, webhook custody), so a
        // genuine FK violation is impossible at this statement. Prisma's engine
        // classifies the statement's SQLITE_CONSTRAINT result as its typed
        // foreign-key rejection and does not surface the trigger's message text
        // (only raw $executeRawUnsafe statements keep it verbatim), so accept
        // either the injected message or the engine's typed FK rejection. The
        // retry below still discriminates: with an erase that forgot a RESTRICT
        // child, the retry would fail too; with the injected trigger it succeeds.
        const firstAttempt = await deleteAccountForErasure({ accountId, now: NOW }).then(
            () => null,
            (error: unknown) => error,
        );
        expect(firstAttempt).toBeInstanceOf(Error);
        const firstMessage = firstAttempt instanceof Error ? firstAttempt.message : "";
        expect(
            firstMessage.includes("injected account deletion failure")
                || firstMessage.includes("Foreign key constraint violated"),
        ).toBe(true);
        await expect(db.account.findUnique({ where: { id: accountId } })).resolves.not.toBeNull();
        await expect(db.machine.findUnique({ where: { id: `machine-rollback-${suffix}` } })).resolves.not.toBeNull();
        await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: sharedEndpointId } }))
            .resolves.toMatchObject({
                accountId,
                pluginId: "happier.github",
                enabled: true,
                releasedAt: null,
                tombstoneExpiresAt: null,
            });

        await db.$executeRawUnsafe("DROP TRIGGER prevent_account_erasure");
        await expect(deleteAccountForErasure({ accountId, now: NOW })).resolves.toEqual({ status: "deleted" });
        await expect(db.machine.findUnique({ where: { id: `machine-rollback-${suffix}` } })).resolves.toBeNull();
        await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: sharedEndpointId } }))
            .resolves.toMatchObject({
                accountId: null,
                pluginId: null,
                enabled: false,
                releasedAt: NOW,
                tombstoneExpiresAt: TOMBSTONE_EXPIRES_AT,
            });
    });
});
