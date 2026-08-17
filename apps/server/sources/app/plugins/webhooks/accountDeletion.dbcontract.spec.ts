import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { deleteAccountForErasure } from "@/app/plugins/data/accountDataErase";

function randomEndpointId(): string {
    return `wh_ep_${Buffer.from(randomUUID().replace(/-/gu, ""), "hex").toString("base64url")}`;
}

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported plugin webhook Account-deletion contract provider: ${raw}`);
}

describe("plugin webhook Account-deletion native database contract", () => {
    const provider = resolveContractProvider();
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for DB contract test");
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await db.$disconnect();
    });

    it("deletes Account-owned route custody and preserves one scrubbed shared-installation tombstone", async () => {
        const suffix = randomUUID();
        const accountId = `webhook-delete-contract-${suffix}`;
        const accountEndpointId = randomEndpointId();
        const sharedEndpointId = randomEndpointId();
        const reboundAccountId = `webhook-delete-contract-rebind-${suffix}`;
        const now = new Date("2026-08-10T10:00:00.000Z");
        let routeIds: string[] = [];
        let accountRouteCredentialIds: string[] = [];
        try {
            await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
            const accountRoute = await db.pluginWebhookRoute.create({
                data: {
                    opaqueRouteId: `opaque-account-contract-${suffix}`,
                    verifierKind: "github_hmac_sha256_v1",
                    routingKind: "accountEndpoint",
                },
            });
            const sharedRouteRecord = await db.pluginWebhookRoute.create({
                data: {
                    opaqueRouteId: `opaque-shared-contract-${suffix}`,
                    verifierKind: "github_hmac_sha256_v1",
                    routingKind: "providerInstallation",
                    operatorPluginId: `happier.github.contract.${suffix}`,
                    operatorWebhookContributionId: "github-events",
                },
            });
            const accountRouteId = accountRoute.id;
            const sharedRouteId = sharedRouteRecord.id;
            routeIds = [accountRouteId, sharedRouteId];
            for (const [endpointId, routeId, routingKind, marker] of [
                [accountEndpointId, accountRouteId, "accountEndpoint", "account"],
                [sharedEndpointId, sharedRouteId, "providerInstallation", "shared"],
            ] as const) {
                await db.pluginWebhookEndpoint.create({
                    data: {
                        id: endpointId,
                        accountId,
                        pluginId: "happier.github",
                        webhookContributionId: "github-events",
                        handlerActionId: "channels/webhook-receive-v1",
                        sourceInstanceId: `${marker}-source-${suffix}`,
                        ensureIdempotencyKey: `${marker}-idempotency-${suffix}`,
                        ensureRequestFingerprint: marker.repeat(64).slice(0, 64),
                        setupKind: routingKind === "accountEndpoint"
                            ? "githubAccountEndpointV1"
                            : "githubSharedInstallationV1",
                        routeId,
                        routingKind,
                        ...(routingKind === "providerInstallation" ? { providerInstallationId: "987654321" } : {}),
                        targetMachineId: `machine-${marker}`,
                        targetMachineInstallationId: `installation-${marker}`,
                        targetMaterializationId: `materialization-${marker}`,
                        targetPluginVersion: "1.0.0",
                    },
                });
                const currentCredential = await db.pluginWebhookCredential.create({
                    data: {
                        routeId,
                        credentialVersionId: `credential-${marker}-current-${suffix}`,
                        verifierKind: "github_hmac_sha256_v1",
                        encryptedSecret: Buffer.from(`secret-${marker}`),
                        state: "current",
                    },
                });
                const previousCredential = routingKind === "accountEndpoint"
                    ? await db.pluginWebhookCredential.create({
                        data: {
                            routeId,
                            credentialVersionId: `credential-${marker}-previous-${suffix}`,
                            verifierKind: "github_hmac_sha256_v1",
                            encryptedSecret: Buffer.from(`secret-${marker}-previous`),
                            state: "previous",
                        },
                    })
                    : null;
                if (previousCredential) accountRouteCredentialIds = [currentCredential.id, previousCredential.id];
                await db.pluginWebhookRoute.update({
                    where: { id: routeId },
                    data: {
                        currentCredentialId: currentCredential.id,
                        ...(previousCredential ? { previousCredentialId: previousCredential.id } : {}),
                        ...(routingKind === "accountEndpoint" ? { accountEndpointId: endpointId } : {}),
                    },
                });
            }

            // The native FK rejects a raw delete; only the generic Account owner can detach the
            // shared row to its exact replay-isolation tombstone before removing the Account.
            await expect(db.account.delete({ where: { id: accountId } })).rejects.toThrow();
            await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: sharedEndpointId } }))
                .resolves.toMatchObject({ accountId, pluginId: "happier.github", releasedAt: null });

            await expect(deleteAccountForErasure({ accountId, now })).resolves.toEqual({ status: "deleted" });

            expect(await db.pluginWebhookEndpoint.findUnique({ where: { id: accountEndpointId } })).toBeNull();
            expect(await db.pluginWebhookRoute.findUnique({ where: { id: accountRouteId } })).toBeNull();
            expect(accountRouteCredentialIds).toHaveLength(2);
            await expect(Promise.all(accountRouteCredentialIds.map(async (id) => (
                await db.pluginWebhookCredential.findUnique({ where: { id } })
            )))).resolves.toEqual([null, null]);

            const sharedRoute = await db.pluginWebhookRoute.findUniqueOrThrow({
                where: { id: sharedRouteId },
                include: { credentials: true },
            });
            expect(sharedRoute.credentials).toHaveLength(1);
            expect(Buffer.from(sharedRoute.credentials[0]!.encryptedSecret).toString()).toBe("secret-shared");
            await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: sharedEndpointId } }))
                .resolves.toMatchObject({
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
                    providerInstallationId: "987654321",
                    enabled: false,
                    revokedAt: null,
                    releasedAt: now,
                    tombstoneExpiresAt: new Date("2026-08-17T10:00:00.000Z"),
                    targetMachineId: null,
                    targetMachineInstallationId: null,
                    targetMaterializationId: null,
                    targetPluginVersion: null,
                });
            await expect(deleteAccountForErasure({ accountId, now })).resolves.toEqual({ status: "already-deleted" });

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
                    providerInstallationId: "987654321",
                    targetMachineId: "machine-rebind",
                    targetMachineInstallationId: "installation-rebind",
                    targetMaterializationId: "materialization-rebind",
                    targetPluginVersion: "1.0.0",
                },
            })).rejects.toThrow();
        } finally {
            await db.pluginWebhookDelivery.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.pluginWebhookEndpointOperation.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.pluginWebhookRoute.updateMany({
                where: { id: { in: routeIds } },
                data: { accountEndpointId: null, currentCredentialId: null, previousCredentialId: null },
            }).catch(() => undefined);
            await db.pluginWebhookCredential.deleteMany({
                where: { routeId: { in: routeIds } },
            }).catch(() => undefined);
            await db.pluginWebhookEndpoint.deleteMany({
                where: { id: { in: [accountEndpointId, sharedEndpointId] } },
            }).catch(() => undefined);
            await db.pluginWebhookRoute.deleteMany({
                where: { id: { in: routeIds } },
            }).catch(() => undefined);
            await db.account.deleteMany({ where: { id: { in: [accountId, reboundAccountId] } } }).catch(() => undefined);
        }
    });

    it("rolls back detachment when a retained Account FK rejects deletion, then permits the same owner retry", async () => {
        const suffix = randomUUID();
        const accountId = `webhook-delete-contract-rollback-${suffix}`;
        const endpointId = randomEndpointId();
        const machineId = `machine-contract-rollback-${suffix}`;
        const now = new Date("2026-08-10T10:00:00.000Z");
        let routeIds: string[] = [];
        let routeCredentialIds: string[] = [];
        try {
            await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
            const route = await db.pluginWebhookRoute.create({
                data: {
                    opaqueRouteId: `opaque-account-contract-rollback-${suffix}`,
                    verifierKind: "github_hmac_sha256_v1",
                    routingKind: "accountEndpoint",
                },
            });
            const routeId = route.id;
            routeIds = [routeId];
            await db.pluginWebhookEndpoint.create({
                data: {
                    id: endpointId,
                    accountId,
                    pluginId: "happier.github",
                    webhookContributionId: "github-events",
                    handlerActionId: "channels/webhook-receive-v1",
                    sourceInstanceId: `rollback-source-${suffix}`,
                    ensureIdempotencyKey: `rollback-idempotency-${suffix}`,
                    ensureRequestFingerprint: "d".repeat(64),
                    setupKind: "githubAccountEndpointV1",
                    routeId,
                    routingKind: "accountEndpoint",
                    targetMachineId: "machine-rollback",
                    targetMachineInstallationId: "installation-rollback",
                    targetMaterializationId: "materialization-rollback",
                    targetPluginVersion: "1.0.0",
                },
            });
            const currentCredential = await db.pluginWebhookCredential.create({
                data: {
                    routeId,
                    credentialVersionId: `cred-rb-current-${suffix}`,
                    verifierKind: "github_hmac_sha256_v1",
                    encryptedSecret: Buffer.from("secret-rollback-current"),
                    state: "current",
                },
            });
            const previousCredential = await db.pluginWebhookCredential.create({
                data: {
                    routeId,
                    credentialVersionId: `cred-rb-previous-${suffix}`,
                    verifierKind: "github_hmac_sha256_v1",
                    encryptedSecret: Buffer.from("secret-rollback-previous"),
                    state: "previous",
                },
            });
            routeCredentialIds = [currentCredential.id, previousCredential.id];
            await db.pluginWebhookRoute.update({
                where: { id: routeId },
                data: {
                    accountEndpointId: endpointId,
                    currentCredentialId: currentCredential.id,
                    previousCredentialId: previousCredential.id,
                },
            });
            await db.machine.create({
                data: { id: machineId, accountId, metadata: "fixture" },
            });

            await expect(deleteAccountForErasure({ accountId, now })).rejects.toThrow();
            await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } }))
                .resolves.toMatchObject({
                    accountId,
                    pluginId: "happier.github",
                    enabled: true,
                    releasedAt: null,
                    tombstoneExpiresAt: null,
                });
            await expect(db.pluginWebhookRoute.findUniqueOrThrow({ where: { id: routeId } }))
                .resolves.toMatchObject({
                    accountEndpointId: endpointId,
                    currentCredentialId: currentCredential.id,
                    previousCredentialId: previousCredential.id,
                });
            await expect(Promise.all(routeCredentialIds.map(async (id) => (
                await db.pluginWebhookCredential.findUnique({ where: { id } })
            )))).resolves.toEqual([
                expect.objectContaining({ id: currentCredential.id, routeId, state: "current" }),
                expect.objectContaining({ id: previousCredential.id, routeId, state: "previous" }),
            ]);

            await db.machine.delete({ where: { id: machineId } });
            await expect(deleteAccountForErasure({ accountId, now })).resolves.toEqual({ status: "deleted" });
            expect(await db.pluginWebhookEndpoint.findUnique({ where: { id: endpointId } })).toBeNull();
            expect(await db.pluginWebhookRoute.findUnique({ where: { id: routeId } })).toBeNull();
            await expect(Promise.all(routeCredentialIds.map(async (id) => (
                await db.pluginWebhookCredential.findUnique({ where: { id } })
            )))).resolves.toEqual([null, null]);
        } finally {
            await db.machine.deleteMany({ where: { id: machineId } }).catch(() => undefined);
            await db.pluginWebhookRoute.updateMany({
                where: { id: { in: routeIds } },
                data: { accountEndpointId: null, currentCredentialId: null, previousCredentialId: null },
            }).catch(() => undefined);
            await db.pluginWebhookCredential.deleteMany({
                where: { routeId: { in: routeIds } },
            }).catch(() => undefined);
            await db.pluginWebhookEndpoint.deleteMany({ where: { id: endpointId } }).catch(() => undefined);
            await db.pluginWebhookRoute.deleteMany({ where: { id: { in: routeIds } } }).catch(() => undefined);
            await db.account.deleteMany({ where: { id: accountId } }).catch(() => undefined);
        }
    });
});
