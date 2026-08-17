import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { normalizePluginReleaseFactsV1 } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    discardPluginWebhookDeliveryV1,
    purgeExpiredPluginWebhookDeliveriesV1,
    replayPluginWebhookDeliveryV1,
} from "./retention";

const SERVER_IDENTITY_ID = "srv_webhookRetention1";
const AUTOMATION_ADMISSION_UNRESOLVED = {
    v: 1,
    kind: "automationAdmissionUnresolved",
    totalCount: 1,
    entries: [{
        automationId: "automation-1",
        status: { kind: "blocked", reason: "capacity" },
    }],
    omittedCount: 0,
} as const;
const RELEASE_FACTS = normalizePluginReleaseFactsV1({
    ref: { pluginId: "acme.github", version: "1.0.0" },
    archiveDigestSha256: `sha256:${"a".repeat(64)}`,
    normalizedManifest: {
        schemaVersion: 2,
        id: "acme.github",
        version: "1.0.0",
        displayName: "GitHub",
        engines: { happier: "^1.0.0" },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: "./dist/index.js" },
        contributes: {
            actions: [{
                id: "handle-webhook",
                title: "Handle webhook",
                scopes: ["global"],
                surfaces: ["plugin"],
                dangerLevel: "safe",
            }],
            webhooks: [{
                id: "github-events",
                title: "GitHub events",
                verifier: { kind: "github_hmac_sha256_v1", routing: "accountEndpoint" },
                handlerAction: { localId: "handle-webhook" },
            }],
        },
    },
    collectionContracts: [],
    uiSlots: [],
    packageAssetArchive: {
        archiveDigestSha256: `sha256:${"d".repeat(64)}`,
        resources: [],
    },
});

describe("plugin webhook retention and explicit discard", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-webhook-retention-",
            initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID },
        });
    }, 120_000);

    afterAll(async () => {
        await harness?.close();
    });

    afterEach(async () => {
        harness?.resetEnv();
        await harness?.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.pluginWebhookDelivery.deleteMany(),
            () => db.pluginWebhookEndpoint.deleteMany(),
            () => db.pluginWebhookRoute.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createFixture(suffix: string) {
        const account = await db.account.create({
            data: { id: `account-${suffix}`, publicKey: `pk-${suffix}`, encryptionMode: "plain" },
        });
        if (suffix === "b") {
            await db.accountPluginIntent.create({
                data: {
                    accountId: account.id,
                    pluginId: "acme.github",
                    desiredVersion: "1.0.0",
                    enabled: true,
                    writableCollections: [],
                },
            });
            await db.accountPluginRelease.create({
                data: {
                    accountId: account.id,
                    pluginId: "acme.github",
                    version: "1.0.0",
                    archiveDigestSha256: RELEASE_FACTS.archiveDigestSha256,
                    normalizedManifest: RELEASE_FACTS.normalizedManifest,
                    collectionContracts: RELEASE_FACTS.collectionContracts,
                    uiSlots: RELEASE_FACTS.uiSlots,
                    packageAssetArchive: RELEASE_FACTS.packageAssetArchive,
                },
            });
            await db.machine.create({
                data: {
                    id: "machine-1",
                    accountId: account.id,
                    metadata: "{}",
                    installationId: "installation-1",
                    pluginMaterializationRevision: 1n,
                    operationProtocolCapabilities: {
                        pluginWebhookClaim: { protocolVersions: [1] },
                    },
                    operationProtocolCapabilitiesRevision: 1,
                },
            });
            await db.pluginMachineMaterialization.create({
                data: {
                    accountId: account.id,
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: "machine-1",
                    materializationId: "materialization-1",
                    pluginId: "acme.github",
                    version: "1.0.0",
                    sourceClass: "registryPackage",
                    portableRelease: true,
                    archiveDigestSha256: RELEASE_FACTS.archiveDigestSha256,
                    uiArtifacts: [],
                    enabled: true,
                    trustState: "trusted",
                    observedAt: new Date("2026-08-10T00:00:00.000Z"),
                },
            });
        }
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: `route-${suffix}`,
                opaqueRouteId: `opaque-${suffix}`,
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
            },
        });
        const endpoint = await db.pluginWebhookEndpoint.create({
            data: {
                id: `wh_ep_AAECAwQFBgcICQoLDA0O${suffix === "a" ? "Dw" : suffix === "b" ? "DA" : "DQ"}`,
                accountId: account.id,
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: `source-${suffix}`,
                ensureIdempotencyKey: `idempotency-${suffix}-0001`,
                ensureRequestFingerprint: suffix.repeat(64),
                setupKind: "githubAccountEndpointV1",
                routeId: route.id,
                routingKind: "accountEndpoint",
                targetMachineId: "machine-1",
                targetMachineInstallationId: "installation-1",
                targetMaterializationId: "materialization-1",
                targetPluginVersion: "1.0.0",
            },
        });
        await db.pluginWebhookRoute.update({
            where: { id: route.id },
            data: { accountEndpointId: endpoint.id },
        });
        return { account, route, endpoint };
    }

    async function createDelivery(params: {
        suffix: string;
        state: "queued" | "claimed" | "succeeded" | "dead_letter";
        now: Date;
        leaseExpiresAt?: Date;
        payloadPurgeAt?: Date;
        metadataDeleteAt?: Date;
        automationAdmissionUnresolved?: typeof AUTOMATION_ADMISSION_UNRESOLVED;
    }) {
        const fixture = await createFixture(params.suffix);
        const payloadBearing = params.state === "queued" || params.state === "claimed" || params.state === "dead_letter";
        const delivery = await db.pluginWebhookDelivery.create({
            data: {
                id: `delivery-${params.suffix}`,
                endpointId: fixture.endpoint.id,
                accountId: fixture.account.id,
                routeId: fixture.route.id,
                deliveryIdentityDigest: params.suffix.repeat(64),
                verifierKind: "github_hmac_sha256_v1",
                targetMachineId: "machine-1",
                targetMachineInstallationId: "installation-1",
                targetMaterializationId: "materialization-1",
                targetPluginId: "acme.github",
                targetPluginVersion: "1.0.0",
                endpointRevision: fixture.endpoint.revision,
                endpointWebhookContributionId: "github-events",
                endpointHandlerActionId: "handle-webhook",
                endpointSourceInstanceId: `source-${params.suffix}`,
                payloadKind: "plain",
                payload: payloadBearing ? { t: "plain", v: { test: params.suffix } } : undefined,
                payloadBytes: payloadBearing ? 64n : 0n,
                wireVersion: 1,
                payloadVersion: 1,
                state: params.state,
                ...(params.automationAdmissionUnresolved
                    ? { automationAdmissionUnresolved: params.automationAdmissionUnresolved }
                    : {}),
                nextAttemptAt: params.now,
                leaseId: params.state === "claimed" ? `lease-${params.suffix}` : null,
                claimedByMachineId: params.state === "claimed" ? "machine-1" : null,
                claimedByMachineInstallationId: params.state === "claimed" ? "installation-1" : null,
                firstClaimAt: params.state === "claimed" ? new Date(params.now.getTime() - 60_000) : null,
                leaseExpiresAt: params.leaseExpiresAt ?? null,
                succeededAt: params.state === "succeeded" ? params.now : null,
                deadLetteredAt: params.state === "dead_letter" ? params.now : null,
                payloadPurgeAt: params.payloadPurgeAt
                    ?? (params.state === "dead_letter"
                        ? new Date(params.now.getTime() + 30 * 24 * 60 * 60 * 1_000)
                        : null),
                metadataDeleteAt: params.metadataDeleteAt ?? new Date(params.now.getTime() + 90 * 24 * 60 * 60 * 1_000),
                receivedAt: params.now,
            },
        });
        return { ...fixture, delivery };
    }

    async function readWebhookChange(accountId: string) {
        return await db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId,
                    kind: "pluginDomain",
                    entityId: "pluginDomain/acme.github/webhook",
                },
            },
            select: { cursor: true, hint: true },
        });
    }

    it("refuses an active lease and discards atomically once the lease is no longer active", async () => {
        const now = new Date("2026-08-10T00:00:00.000Z");
        const fixture = await createDelivery({
            suffix: "a",
            state: "claimed",
            now,
            leaseExpiresAt: new Date(now.getTime() + 1),
            automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED,
        });

        expect(await discardPluginWebhookDeliveryV1({
            accountId: fixture.account.id,
            deliveryId: fixture.delivery.id,
            expectedRevision: 0,
            discardedByUserId: "user-1",
            reasonCode: "user_requested",
            now,
        })).toEqual({ kind: "leaseActive", currentRevision: 0 });
        await expect(db.accountChange.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);

        expect(await discardPluginWebhookDeliveryV1({
            accountId: fixture.account.id,
            deliveryId: fixture.delivery.id,
            expectedRevision: 0,
            discardedByUserId: "user-1",
            reasonCode: "user_requested",
            now: new Date(now.getTime() + 1),
        })).toEqual({ kind: "discarded", revision: 1 });
        const discarded = await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: fixture.delivery.id } });
        expect(discarded).toMatchObject({
            state: "discarded",
            payload: null,
            payloadBytes: 0n,
            revision: 1,
            leaseId: null,
            discardedByUserId: "user-1",
            discardReasonCode: "user_requested",
            automationAdmissionUnresolved: null,
        });
        expect(discarded.metadataDeleteAt.toISOString()).toBe("2026-09-09T00:00:00.001Z");
        await expect(readWebhookChange(fixture.account.id)).resolves.toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
    });

    it("purges dead-letter payload and deletes expired compact metadata at the exact deadline", async () => {
        const now = new Date("2026-08-10T00:00:00.000Z");
        const dead = await createDelivery({ suffix: "b", state: "dead_letter", now, payloadPurgeAt: now });
        const success = await createDelivery({ suffix: "c", state: "succeeded", now, metadataDeleteAt: now });

        expect(await purgeExpiredPluginWebhookDeliveriesV1({ now, batchSize: 100 })).toEqual({
            payloadsPurged: 1,
            metadataDeleted: 1,
            tombstonesDeleted: 0,
        });
        expect(await db.pluginWebhookDelivery.findUnique({ where: { id: success.delivery.id } })).toBeNull();
        expect(await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: dead.delivery.id } })).toMatchObject({
            state: "dead_letter",
            payload: null,
            payloadBytes: 0n,
        });
        await expect(readWebhookChange(dead.account.id)).resolves.toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
        await expect(readWebhookChange(success.account.id)).resolves.toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
    });

    it("keeps a detached shared-installation tombstone through its cooling horizon and purges it at the exact deadline", async () => {
        const now = new Date("2026-08-17T00:00:00.000Z");
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: "route-shared-tombstone",
                opaqueRouteId: "opaque-shared-tombstone",
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "providerInstallation",
                operatorPluginId: "acme.github",
                operatorWebhookContributionId: "github-events",
            },
        });
        const expired = await db.pluginWebhookEndpoint.create({
            data: {
                id: "wh_ep_AAECAwQFBgcICQoLDA0OEA",
                routeId: route.id,
                routingKind: "providerInstallation",
                providerInstallationId: "445566778",
                enabled: false,
                revision: 2,
                releasedAt: new Date("2026-08-10T00:00:00.000Z"),
                tombstoneExpiresAt: now,
            },
        });
        const pending = await db.pluginWebhookEndpoint.create({
            data: {
                id: "wh_ep_AAECAwQFBgcICQoLDA0OEQ",
                routeId: route.id,
                routingKind: "providerInstallation",
                providerInstallationId: "445566779",
                enabled: false,
                revision: 2,
                releasedAt: new Date("2026-08-10T00:00:00.000Z"),
                tombstoneExpiresAt: new Date(now.getTime() + 1),
            },
        });

        await expect(purgeExpiredPluginWebhookDeliveriesV1({
            now: new Date(now.getTime() - 1),
            batchSize: 100,
        })).resolves.toEqual({
            payloadsPurged: 0,
            metadataDeleted: 0,
            tombstonesDeleted: 0,
        });
        await expect(db.pluginWebhookEndpoint.findUnique({ where: { id: expired.id } })).resolves.not.toBeNull();

        await expect(purgeExpiredPluginWebhookDeliveriesV1({ now, batchSize: 100 })).resolves.toEqual({
            payloadsPurged: 0,
            metadataDeleted: 0,
            tombstonesDeleted: 1,
        });
        await expect(db.pluginWebhookEndpoint.findUnique({ where: { id: expired.id } })).resolves.toBeNull();
        await expect(db.pluginWebhookEndpoint.findUnique({ where: { id: pending.id } })).resolves.not.toBeNull();
    });

    it("requeues a payload-bearing dead letter under revision CAS without replacing its frozen target", async () => {
        const now = new Date("2026-08-10T00:00:00.000Z");
        const fixture = await createDelivery({
            suffix: "b",
            state: "dead_letter",
            now,
            automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED,
        });

        await expect(replayPluginWebhookDeliveryV1({
            accountId: fixture.account.id,
            deliveryId: fixture.delivery.id,
            expectedRevision: 0,
            now,
        })).resolves.toEqual({ kind: "requeued", revision: 1 });
        const replayedChange = await readWebhookChange(fixture.account.id);
        expect(replayedChange).toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
        await expect(replayPluginWebhookDeliveryV1({
            accountId: fixture.account.id,
            deliveryId: fixture.delivery.id,
            expectedRevision: 0,
            now,
        })).resolves.toEqual({ kind: "unavailable" });

        expect(await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: fixture.delivery.id } })).toMatchObject({
            state: "queued",
            revision: 1,
            attemptCount: 0,
            replayCount: 1,
            targetMachineId: "machine-1",
            targetMachineInstallationId: "installation-1",
            targetMaterializationId: "materialization-1",
            targetPluginId: "acme.github",
            targetPluginVersion: "1.0.0",
            automationAdmissionUnresolved: null,
        });
    });
});
