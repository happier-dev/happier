import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { normalizePluginReleaseFactsV1 } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { readPluginWebhookAccountStatusV1 } from "./statusStore";

const ACCOUNT_ID = "account-webhook-status";
const SERVER_IDENTITY_ID = "srv_webhookStatusCurrent1";
const ENDPOINT_ID = "wh_ep_AAECAwQFBgcICQoLDA0ODw";
const NOW = new Date("2026-08-10T00:00:00.000Z");

describe("plugin webhook Account status projection", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-webhook-status-",
            initAuth: false,
            env: {
                HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID,
                HAPPIER_PUBLIC_SERVER_URL: "https://happier.example",
            },
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        harness?.resetEnv();
        await harness?.resetDbTables([
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

    async function seedFixture(
        options: Readonly<{ providerConfirmedAt?: Date }> = {},
    ): Promise<void> {
        const manifest = {
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
                    execution: { target: "daemon" },
                }],
                webhooks: [{
                    id: "github-events",
                    title: "GitHub events",
                    verifier: { kind: "github_hmac_sha256_v1", routing: "accountEndpoint" },
                    handlerAction: { localId: "handle-webhook" },
                }],
            },
        } as const;
        const releaseFacts = normalizePluginReleaseFactsV1({
            ref: { pluginId: "acme.github", version: "1.0.0" },
            archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            normalizedManifest: manifest,
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${"d".repeat(64)}`,
                resources: [],
            },
        });
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: "installation-1",
                pluginMaterializationRevision: 1n,
                operationProtocolCapabilities: {
                    pluginWebhookClaim: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: "acme.github",
                desiredVersion: "1.0.0",
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: "acme.github",
                version: "1.0.0",
                archiveDigestSha256: releaseFacts.archiveDigestSha256,
                normalizedManifest: releaseFacts.normalizedManifest,
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: releaseFacts.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: "machine-1",
                materializationId: "materialization-1",
                pluginId: "acme.github",
                version: "1.0.0",
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: releaseFacts.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: NOW,
            },
        });
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: "route-status",
                opaqueRouteId: "opaque-status",
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
            },
        });
        const currentCredential = await db.pluginWebhookCredential.create({
            data: {
                routeId: route.id,
                credentialVersionId: "credential-current",
                verifierKind: "github_hmac_sha256_v1",
                encryptedSecret: new Uint8Array([1]),
                state: "current",
            },
        });
        const previousCredential = await db.pluginWebhookCredential.create({
            data: {
                routeId: route.id,
                credentialVersionId: "credential-previous",
                verifierKind: "github_hmac_sha256_v1",
                encryptedSecret: new Uint8Array([2]),
                state: "previous",
                acceptUntil: new Date(NOW.getTime() + 60_000),
            },
        });
        await db.pluginWebhookEndpoint.create({
            data: {
                id: ENDPOINT_ID,
                accountId: ACCOUNT_ID,
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "source-status",
                ensureIdempotencyKey: "status-idempotency-key-0001",
                ensureRequestFingerprint: "a".repeat(64),
                setupKind: "githubAccountEndpointV1",
                routeId: route.id,
                routingKind: "accountEndpoint",
                targetMachineId: "machine-1",
                targetMachineInstallationId: "installation-1",
                targetMaterializationId: "materialization-1",
                targetPluginVersion: "1.0.0",
                previousTargetMachineId: "machine-old",
                previousTargetMachineInstallationId: "installation-old",
                previousTargetMaterializationId: "materialization-old",
                previousTargetPluginVersion: "1.0.0",
                createdAt: NOW,
                providerConfirmedAt: options.providerConfirmedAt ?? null,
            },
        });
        await db.pluginWebhookRoute.update({
            where: { id: route.id },
            data: {
                accountEndpointId: ENDPOINT_ID,
                currentCredentialId: currentCredential.id,
                previousCredentialId: previousCredential.id,
            },
        });
        for (const delivery of [
            { id: "delivery-queued", state: "queued", attempts: 0, digest: "a" },
            { id: "delivery-retrying", state: "queued", attempts: 2, digest: "b" },
            { id: "delivery-claimed", state: "claimed", attempts: 1, digest: "c" },
            { id: "delivery-dead", state: "dead_letter", attempts: 12, digest: "d" },
        ] as const) {
            await db.pluginWebhookDelivery.create({
                data: {
                    id: delivery.id,
                    endpointId: ENDPOINT_ID,
                    accountId: ACCOUNT_ID,
                    routeId: route.id,
                    deliveryIdentityDigest: delivery.digest.repeat(64),
                    verifierKind: "github_hmac_sha256_v1",
                    targetMachineId: delivery.state === "claimed" ? "machine-1" : "machine-old",
                    targetMachineInstallationId: delivery.state === "claimed" ? "installation-1" : "installation-old",
                    targetMaterializationId: delivery.state === "claimed" ? "materialization-1" : "materialization-old",
                    targetPluginId: "acme.github",
                    targetPluginVersion: "1.0.0",
                    endpointRevision: 1,
                    endpointWebhookContributionId: "github-events",
                    endpointHandlerActionId: "handle-webhook",
                    endpointSourceInstanceId: "source-status",
                    payloadKind: "plain",
                    payload: { t: "plain", v: { secret: "must-not-project" } },
                    payloadBytes: 64n,
                    wireVersion: 1,
                    payloadVersion: 1,
                    state: delivery.state,
                    attemptCount: delivery.attempts,
                    nextAttemptAt: NOW,
                    leaseId: delivery.state === "claimed" ? "lease-status" : null,
                    claimedByMachineId: delivery.state === "claimed" ? "machine-1" : null,
                    claimedByMachineInstallationId: delivery.state === "claimed" ? "installation-1" : null,
                    leaseExpiresAt: delivery.state === "claimed" ? new Date(NOW.getTime() + 60_000) : null,
                    lastErrorCode: delivery.state === "dead_letter" ? "handler_failed" : null,
                    ...(delivery.state === "dead_letter" ? {
                        automationAdmissionUnresolved: {
                            v: 1,
                            kind: "automationAdmissionUnresolved",
                            totalCount: 2,
                            entries: [
                                {
                                    automationId: "automation-a",
                                    status: { kind: "blocked", reason: "capacity" },
                                },
                                {
                                    automationId: "automation-b",
                                    status: { kind: "refreshDefinition", reason: "definitionStale" },
                                },
                            ],
                            omittedCount: 0,
                        },
                    } : {}),
                    deadLetteredAt: delivery.state === "dead_letter" ? NOW : null,
                    metadataDeleteAt: new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1_000),
                    receivedAt: NOW,
                },
            });
        }
    }

    it("reports an endpoint no verified delivery has confirmed as not yet ready", async () => {
        // Same current target and live route as the ready case below: the only
        // difference is that no verified provider delivery ever arrived.
        await seedFixture();

        await expect(readPluginWebhookAccountStatusV1({
            accountId: ACCOUNT_ID,
            input: { pageSize: 50, deadLetterPageSize: 0 },
        })).resolves.toMatchObject({
            endpoints: [{
                webhookEndpointId: ENDPOINT_ID,
                readiness: "providerConfirmationRequired",
                targetStatus: "current",
            }],
        });
    });

    it("lists committed endpoints with exact target readiness and bounded queue/dead-letter metadata", async () => {
        await seedFixture({ providerConfirmedAt: NOW });

        const result = await readPluginWebhookAccountStatusV1({
            accountId: ACCOUNT_ID,
            input: { pageSize: 50, deadLetterPageSize: 50 },
        });

        expect(result).toMatchObject({
            endpoints: [{
                webhookEndpointId: ENDPOINT_ID,
                targetMaterialization: {
                    machineId: "machine-1",
                    materializationId: "materialization-1",
                    pluginId: "acme.github",
                },
                readiness: "ready",
                targetStatus: "current",
                publicUrl: "https://happier.example/v1/plugins/webhooks/opaque-status",
                queue: { queued: 1, retrying: 1, claimed: 1, deadLetter: 1 },
                pendingTargetTransfer: {
                    previousTargetMaterialization: {
                        machineId: "machine-old",
                        materializationId: "materialization-old",
                        pluginId: "acme.github",
                    },
                    eligibleDeliveryCount: 3,
                },
                credentialRotation: {
                    previousCredentialVersionId: "credential-previous",
                    previousAcceptUntilMs: NOW.getTime() + 60_000,
                },
            }],
            deadLetters: [{
                deliveryId: "delivery-dead",
                deliveryIdentityDigestPrefix: "dddddddddddd",
                errorCode: "handler_failed",
                attemptCount: 12,
                automationAdmissionUnresolved: {
                    v: 1,
                    kind: "automationAdmissionUnresolved",
                    totalCount: 2,
                    entries: [
                        {
                            automationId: "automation-a",
                            status: { kind: "blocked", reason: "capacity" },
                        },
                        {
                            automationId: "automation-b",
                            status: { kind: "refreshDefinition", reason: "definitionStale" },
                        },
                    ],
                    omittedCount: 0,
                },
            }],
        });
        expect(JSON.stringify(result)).not.toContain("must-not-project");
        expect(JSON.stringify(result)).not.toContain("payload");
        expect(JSON.stringify(result)).not.toContain("providerDeliveryId");
    });
});
