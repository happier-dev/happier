import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    formatPluginWebhookEndpointIdV1,
    normalizePluginReleaseFactsV1,
    type PluginWebhookAutomationAdmissionUnresolvedV1,
} from "@happier-dev/protocol";
import { failPluginWebhookDeliveryV1 } from "@/app/plugins/webhooks/claimStore";
import { readPluginWebhookAccountStatusV1 } from "@/app/plugins/webhooks/statusStore";
import { db, initDbMysql, initDbPostgres } from "@/storage/db";

const PROVIDER = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
    .trim()
    .toLowerCase();
const SERVER_IDENTITY_ID = "srv_webhookNativeContract1";
const NOW = new Date("2026-08-10T00:00:00.000Z");
const TARGET = {
    materialization: {
        machineId: "machine-webhook-native",
        materializationId: "materialization-webhook-native",
        pluginId: "acme.github",
    },
    machineInstallationId: "installation-webhook-native",
} as const;
const AUTOMATION_ADMISSION_UNRESOLVED: PluginWebhookAutomationAdmissionUnresolvedV1 = {
    v: 1,
    kind: "automationAdmissionUnresolved",
    totalCount: 2,
    entries: [
        {
            automationId: "automation-native-a",
            status: { kind: "refreshDefinition", reason: "definitionStale" },
        },
        {
            automationId: "automation-native-b",
            status: { kind: "blocked", reason: "temporarilyUnavailable" },
        },
    ],
    omittedCount: 0,
};

function resolveProvider(): "postgres" | "mysql" {
    if (PROVIDER === "postgres" || PROVIDER === "postgresql") return "postgres";
    if (PROVIDER === "mysql") return "mysql";
    throw new Error(`Unsupported plugin webhook native contract provider: ${PROVIDER}`);
}

function restoreEnvironmentValue(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

describe("plugin webhook unresolved Automation native database contract", () => {
    const provider = resolveProvider();
    const originalServerIdentityId = process.env.HAPPIER_SERVER_IDENTITY_ID;
    const originalPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for plugin webhook DB contract test");
        process.env.HAPPIER_SERVER_IDENTITY_ID = SERVER_IDENTITY_ID;
        process.env.HAPPIER_PUBLIC_SERVER_URL = "https://happier.example";
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await db.$disconnect();
        restoreEnvironmentValue("HAPPIER_SERVER_IDENTITY_ID", originalServerIdentityId);
        restoreEnvironmentValue("HAPPIER_PUBLIC_SERVER_URL", originalPublicServerUrl);
    });

    it("persists one exhaustion summary through the sole fail CAS and incumbent status reader", async () => {
        const suffix = randomUUID();
        const accountId = `webhook-native-${suffix}`;
        const endpointId = formatPluginWebhookEndpointIdV1(randomBytes(16));
        const routeId = `route-webhook-native-${suffix}`;
        const deliveryId = `delivery-webhook-native-${suffix}`;
        const manifest = {
            schemaVersion: 2,
            id: TARGET.materialization.pluginId,
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
        const release = normalizePluginReleaseFactsV1({
            ref: { pluginId: TARGET.materialization.pluginId, version: "1.0.0" },
            archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            normalizedManifest: manifest,
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${"b".repeat(64)}`,
                resources: [],
            },
        });

        try {
            await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
            await db.accountPluginIntent.create({
                data: {
                    accountId,
                    pluginId: TARGET.materialization.pluginId,
                    desiredVersion: "1.0.0",
                    enabled: true,
                    writableCollections: [],
                },
            });
            await db.accountPluginRelease.create({
                data: {
                    accountId,
                    pluginId: TARGET.materialization.pluginId,
                    version: "1.0.0",
                    archiveDigestSha256: release.archiveDigestSha256,
                    normalizedManifest: release.normalizedManifest,
                    collectionContracts: release.collectionContracts,
                    uiSlots: release.uiSlots,
                    packageAssetArchive: release.packageAssetArchive,
                },
            });
            await db.machine.create({
                data: {
                    id: TARGET.materialization.machineId,
                    accountId,
                    metadata: "{}",
                    installationId: TARGET.machineInstallationId,
                    pluginMaterializationRevision: 1n,
                    operationProtocolCapabilities: {
                        pluginWebhookClaim: { protocolVersions: [1] },
                    },
                    operationProtocolCapabilitiesRevision: 1,
                },
            });
            await db.pluginMachineMaterialization.create({
                data: {
                    accountId,
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: TARGET.materialization.machineId,
                    materializationId: TARGET.materialization.materializationId,
                    pluginId: TARGET.materialization.pluginId,
                    version: "1.0.0",
                    sourceClass: "registryPackage",
                    portableRelease: true,
                    archiveDigestSha256: release.archiveDigestSha256,
                    uiArtifacts: [],
                    enabled: true,
                    trustState: "trusted",
                    observedAt: NOW,
                },
            });
            await db.pluginWebhookRoute.create({
                data: {
                    id: routeId,
                    opaqueRouteId: `opaque-webhook-native-${suffix}`,
                    verifierKind: "github_hmac_sha256_v1",
                    routingKind: "accountEndpoint",
                },
            });
            const endpoint = await db.pluginWebhookEndpoint.create({
                data: {
                    id: endpointId,
                    accountId,
                    pluginId: TARGET.materialization.pluginId,
                    webhookContributionId: "github-events",
                    handlerActionId: "handle-webhook",
                    sourceInstanceId: `source-webhook-native-${suffix}`,
                    ensureIdempotencyKey: `idempotency-webhook-native-${suffix}`,
                    ensureRequestFingerprint: randomBytes(32).toString("hex"),
                    setupKind: "githubAccountEndpointV1",
                    routeId,
                    routingKind: "accountEndpoint",
                    targetMachineId: TARGET.materialization.machineId,
                    targetMachineInstallationId: TARGET.machineInstallationId,
                    targetMaterializationId: TARGET.materialization.materializationId,
                    targetPluginVersion: "1.0.0",
                },
            });
            await db.pluginWebhookRoute.update({
                where: { id: routeId },
                data: { accountEndpointId: endpoint.id },
            });
            await db.pluginWebhookDelivery.create({
                data: {
                    id: deliveryId,
                    endpointId: endpoint.id,
                    accountId,
                    routeId,
                    deliveryIdentityDigest: randomBytes(32).toString("hex"),
                    verifierKind: "github_hmac_sha256_v1",
                    targetMachineId: TARGET.materialization.machineId,
                    targetMachineInstallationId: TARGET.machineInstallationId,
                    targetMaterializationId: TARGET.materialization.materializationId,
                    targetPluginId: TARGET.materialization.pluginId,
                    targetPluginVersion: "1.0.0",
                    endpointRevision: endpoint.revision,
                    endpointWebhookContributionId: "github-events",
                    endpointHandlerActionId: "handle-webhook",
                    endpointSourceInstanceId: `source-webhook-native-${suffix}`,
                    payloadKind: "plain",
                    payload: { t: "plain", v: { v: 1 } },
                    payloadBytes: 1n,
                    wireVersion: 1,
                    payloadVersion: 1,
                    state: "claimed",
                    attemptCount: 12,
                    nextAttemptAt: NOW,
                    leaseId: `lease-webhook-native-${suffix}`,
                    claimedByMachineId: TARGET.materialization.machineId,
                    claimedByMachineInstallationId: TARGET.machineInstallationId,
                    firstClaimAt: new Date(NOW.getTime() - 60_000),
                    executionStartedAt: new Date(NOW.getTime() - 1_000),
                    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
                    metadataDeleteAt: new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1_000),
                    receivedAt: NOW,
                },
            });

            await expect(failPluginWebhookDeliveryV1({
                accountId,
                deliveryId,
                target: TARGET,
                lease: { leaseId: `lease-webhook-native-${suffix}`, revision: 0 },
                result: { kind: "retry", code: "github.automation-unavailable" },
                automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED,
                now: NOW,
                retryDelayMs: 5_000,
            })).resolves.toEqual({ kind: "settled", state: "dead_letter" });

            await expect(db.pluginWebhookDelivery.findUniqueOrThrow({
                where: { id: deliveryId },
                select: { state: true, automationAdmissionUnresolved: true },
            })).resolves.toEqual({
                state: "dead_letter",
                automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED,
            });
            await expect(readPluginWebhookAccountStatusV1({
                accountId,
                input: { pageSize: 100, deadLetterPageSize: 100 },
            })).resolves.toMatchObject({
                deadLetters: [{
                    deliveryId,
                    errorCode: "github.automation-unavailable",
                    attemptCount: 12,
                    automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED,
                }],
            });
        } finally {
            await db.accountChange.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.pluginWebhookDelivery.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.pluginWebhookRoute.updateMany({
                where: { id: routeId },
                data: { accountEndpointId: null },
            }).catch(() => undefined);
            await db.pluginWebhookEndpoint.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.pluginWebhookRoute.deleteMany({ where: { id: routeId } }).catch(() => undefined);
            await db.pluginMachineMaterialization.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.accountPluginRelease.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.accountPluginIntent.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.machine.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.account.deleteMany({ where: { id: accountId } }).catch(() => undefined);
        }
    });
});
