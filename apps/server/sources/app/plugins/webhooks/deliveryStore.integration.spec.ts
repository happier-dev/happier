import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    normalizePluginReleaseFactsV1,
    type PluginWebhookDeliveryContentV1,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    admitPluginWebhookDeliveryV1,
    movePendingPluginWebhookDeliveriesV1,
} from "./deliveryStore";
import { createPluginWebhookStoredEnvelopeV1 } from "./storedEnvelope";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const SERVER_IDENTITY_ID = "srv_webhookDeliveryStore1";
const CONTENT: PluginWebhookDeliveryContentV1 = {
    v: 1,
    receivedAtMs: NOW.getTime(),
    contentType: "application/json",
    headers: [{ name: "x-github-event", value: "issues" }],
    rawBodyBytes: 2,
    rawBodyBase64: "e30=",
    verified: {
        verifier: "github_hmac_sha256_v1",
        providerDeliveryId: "provider-delivery-1",
        eventType: "issues",
        credentialVersionId: "credential-1",
    },
};

function plainStoredEnvelope() {
    const stored = createPluginWebhookStoredEnvelopeV1({
        account: {
            publicKey: null,
            encryptionMode: "plain",
            contentPublicKey: null,
            contentPublicKeySig: null,
        },
        content: CONTENT,
    });
    if (!stored.ok) throw new Error("Expected a plain stored webhook envelope");
    return stored;
}
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

describe("plugin webhook durable delivery admission", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-webhook-delivery-store-",
            initAuth: false,
            sqliteConnectionLimit: 2,
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

    async function seedCurrentTarget() {
        const account = await db.account.create({
            data: { id: "account-delivery", publicKey: null, encryptionMode: "plain" },
        });
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
                observedAt: NOW,
            },
        });
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: "route-delivery",
                opaqueRouteId: "opaque-delivery",
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
            },
        });
        const endpoint = await db.pluginWebhookEndpoint.create({
            data: {
                id: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                accountId: account.id,
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "source-1",
                ensureIdempotencyKey: "idempotency-delivery-0001",
                ensureRequestFingerprint: "a".repeat(64),
                setupKind: "githubAccountEndpointV1",
                routeId: route.id,
                routingKind: "accountEndpoint",
                targetMachineId: "machine-1",
                targetMachineInstallationId: "installation-1",
                targetMaterializationId: "materialization-1",
                targetPluginVersion: "1.0.0",
            },
        });
        await db.pluginWebhookRoute.update({ where: { id: route.id }, data: { accountEndpointId: endpoint.id } });
        return { account, route, endpoint };
    }

    function admissionParams(endpointRevision = 1) {
        return {
            endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            expectedEndpointRevision: endpointRevision,
            routeId: "route-delivery",
            verifierKind: "github_hmac_sha256_v1" as const,
            deliveryIdentityDigest: "a".repeat(64),
            stored: plainStoredEnvelope(),
            now: NOW,
        };
    }

    async function readWebhookChange() {
        return await db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: "account-delivery",
                    kind: "pluginDomain",
                    entityId: "pluginDomain/acme.github/webhook",
                },
            },
            select: { cursor: true, hint: true },
        });
    }

    it("commits one frozen exact-target envelope before scheduling a content-free wake", async () => {
        await seedCurrentTarget();
        const wake = vi.fn();
        const admission = admissionParams();

        await expect(admitPluginWebhookDeliveryV1({ ...admission, onCommittedWake: wake }))
            .resolves.toMatchObject({ kind: "admitted", deliveryId: expect.any(String) });
        expect(wake).toHaveBeenCalledTimes(1);
        const row = await db.pluginWebhookDelivery.findUniqueOrThrow({
            where: { deliveryIdentityDigest: "a".repeat(64) },
        });
        expect(row).toMatchObject({
            accountId: "account-delivery",
            endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            targetMachineId: "machine-1",
            targetMachineInstallationId: "installation-1",
            targetMaterializationId: "materialization-1",
            targetPluginId: "acme.github",
            targetPluginVersion: "1.0.0",
            endpointRevision: 1,
            endpointWebhookContributionId: "github-events",
            endpointHandlerActionId: "handle-webhook",
            endpointSourceInstanceId: "source-1",
            state: "queued",
            attemptCount: 0,
            replayCount: 0,
            payload: JSON.parse(new TextDecoder().decode(admission.stored.canonicalEnvelopeBytes)),
            payloadBytes: BigInt(admission.stored.canonicalEnvelopeBytes.byteLength),
        });
        expect(JSON.stringify(row.payload)).toBe(
            new TextDecoder().decode(admission.stored.canonicalEnvelopeBytes),
        );
        await expect(readWebhookChange()).resolves.toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
    });

    it("reobserves a duplicate without mutating payload, target, attempts, or wake state", async () => {
        await seedCurrentTarget();
        const wake = vi.fn();
        const first = await admitPluginWebhookDeliveryV1({ ...admissionParams(), onCommittedWake: wake });
        const before = await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { deliveryIdentityDigest: "a".repeat(64) } });
        const admittedChange = await readWebhookChange();

        await expect(admitPluginWebhookDeliveryV1({ ...admissionParams(999), onCommittedWake: wake }))
            .resolves.toEqual({ kind: "duplicate", deliveryId: before.id });
        const after = await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: before.id } });
        expect(after).toEqual(before);
        expect(first.kind).toBe("admitted");
        expect(wake).toHaveBeenCalledTimes(1);
        await expect(readWebhookChange()).resolves.toEqual(admittedChange);
    });

    it("rolls back a deadline-expired admission held behind the Account transaction fence without a delivery, dedupe, change, or wake", async () => {
        // Prime the persisted identity before holding SQLite's writer so the
        // admission reaches its own fenced transaction rather than an identity
        // initialization write.
        harness?.resetEnv({ HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID });
        await db.simpleCache.upsert({
            where: { key: "server.identity.v1" },
            create: { key: "server.identity.v1", value: SERVER_IDENTITY_ID },
            update: { value: SERVER_IDENTITY_ID },
        });
        harness?.resetEnv({ HAPPIER_SERVER_IDENTITY_ID: undefined });
        await seedCurrentTarget();

        let releaseFence!: () => void;
        const fenceReleased = new Promise<void>((resolve) => { releaseFence = resolve; });
        let markFenceEntered!: () => void;
        const fenceEntered = new Promise<void>((resolve) => { markFenceEntered = resolve; });
        const holder = inTx(async (tx) => {
            await acquireAccountEncryptionTransitionFenceInTx(tx, "account-delivery");
            markFenceEntered();
            await fenceReleased;
        });
        await fenceEntered;

        const wake = vi.fn();
        const deadlineAdmission = {
            ...admissionParams(),
            deadlineAtMs: Date.now() + 1_200,
            onCommittedWake: wake,
        };
        const admission = admitPluginWebhookDeliveryV1(deadlineAdmission);
        const releaseTimer = setTimeout(releaseFence, 1_500);
        try {
            await expect(admission).rejects.toMatchObject({
                name: "TransactionDeadlineExceededError",
            });
        } finally {
            clearTimeout(releaseTimer);
            releaseFence();
            await holder;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
        await expect(db.pluginWebhookDelivery.count()).resolves.toBe(0);
        await expect(db.pluginWebhookDelivery.count({
            where: { deliveryIdentityDigest: "a".repeat(64) },
        })).resolves.toBe(0);
        await expect(db.accountChange.count()).resolves.toBe(0);
        expect(wake).not.toHaveBeenCalled();
    }, 30_000);

    it("moves queued delivery ownership under the retargeted endpoint and marks the owning webhook domain", async () => {
        await seedCurrentTarget();
        await expect(admitPluginWebhookDeliveryV1(admissionParams())).resolves.toMatchObject({ kind: "admitted" });
        const beforeMove = await readWebhookChange();
        await db.machine.create({
            data: {
                id: "machine-2",
                accountId: "account-delivery",
                metadata: "{}",
                installationId: "installation-2",
                pluginMaterializationRevision: 1n,
                operationProtocolCapabilities: { pluginWebhookClaim: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: "account-delivery",
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: "machine-2",
                materializationId: "materialization-2",
                pluginId: "acme.github",
                version: "1.0.0",
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: RELEASE_FACTS.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: NOW,
            },
        });
        await db.pluginWebhookEndpoint.update({
            where: { id: "wh_ep_AAECAwQFBgcICQoLDA0ODw" },
            data: {
                previousTargetMachineId: "machine-1",
                previousTargetMachineInstallationId: "installation-1",
                previousTargetMaterializationId: "materialization-1",
                previousTargetPluginVersion: "1.0.0",
                targetMachineId: "machine-2",
                targetMachineInstallationId: "installation-2",
                targetMaterializationId: "materialization-2",
                targetPluginVersion: "1.0.0",
                revision: 2,
            },
        });

        await expect(movePendingPluginWebhookDeliveriesV1({
            accountId: "account-delivery",
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            endpointRevision: 2,
            previousTargetMaterialization: {
                machineId: "machine-1",
                materializationId: "materialization-1",
                pluginId: "acme.github",
            },
            targetMaterialization: {
                machineId: "machine-2",
                materializationId: "materialization-2",
                pluginId: "acme.github",
            },
        })).resolves.toEqual({ moved: 1, skippedClaimed: 0, nextCursor: null, done: true });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { deliveryIdentityDigest: "a".repeat(64) } }))
            .resolves.toMatchObject({ targetMachineId: "machine-2", targetMaterializationId: "materialization-2" });
        await expect(readWebhookChange()).resolves.toMatchObject({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
        expect((await readWebhookChange()).cursor).toBeGreaterThan(beforeMove.cursor);
    });

    it("fails closed when endpoint revision, Account mode, or exact target currentness changed", async () => {
        await seedCurrentTarget();
        await expect(admitPluginWebhookDeliveryV1(admissionParams(2))).resolves.toEqual({ kind: "endpointUnavailable" });
        const staleStored = admissionParams().stored;
        await expect(admitPluginWebhookDeliveryV1({
            ...admissionParams(),
            stored: {
                ...staleStored,
                encryption: { mode: "e2ee", contentKeyFingerprint: "sha256:stale" },
            },
        })).resolves.toEqual({ kind: "accountEncryptionChanged" });
        await db.machine.update({ where: { id: "machine-1" }, data: { installationId: "installation-2" } });
        await expect(admitPluginWebhookDeliveryV1(admissionParams())).resolves.toEqual({ kind: "targetUnavailable" });
        await expect(db.pluginWebhookDelivery.count()).resolves.toBe(0);
    });
});
