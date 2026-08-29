import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    normalizePluginReleaseFactsV1,
    type StoredPluginWebhookDeliveryContentV1,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import {
    ageOverduePluginWebhookDeliveriesV1,
    claimPluginWebhookDeliveryV1,
    completePluginWebhookDeliveryV1,
    failPluginWebhookDeliveryV1,
    recoverExpiredPluginWebhookClaimsV1,
    renewPluginWebhookDeliveryV1,
    validateCurrentPluginWebhookInvocationReferenceTxV1,
} from "./claimStore";
import { retargetPluginWebhookEndpointV1 } from "./endpointStore";
import { purgeExpiredPluginWebhookDeliveriesV1 } from "./retention";
import { readPluginWebhookAccountStatusV1 } from "./statusStore";

const SERVER_IDENTITY_ID = "srv_webhookClaimStore1";
const NOW = new Date("2026-08-10T00:00:00.000Z");
const TARGET = {
    materialization: {
        machineId: "machine-claim",
        materializationId: "materialization-claim",
        pluginId: "acme.github",
    },
    machineInstallationId: "installation-claim",
} as const;
const MACHINE_CLAIM = {
    machineId: TARGET.materialization.machineId,
    machineInstallationId: TARGET.machineInstallationId,
} as const;
const RETARGETED = {
    materialization: {
        machineId: "machine-retargeted",
        materializationId: "materialization-retargeted",
        pluginId: "acme.github",
    },
    machineInstallationId: "installation-retargeted",
} as const;
const ENVELOPE: StoredPluginWebhookDeliveryContentV1 = {
    t: "plain",
    v: {
        v: 1,
        receivedAtMs: NOW.getTime(),
        contentType: "application/json",
        headers: [{ name: "x-github-event", value: "issues" }],
        rawBodyBytes: 2,
        rawBodyBase64: "e30=",
        verified: {
            verifier: "github_hmac_sha256_v1",
            providerDeliveryId: "provider-claim-1",
            eventType: "issues",
            credentialVersionId: "credential-claim-1",
        },
    },
};
// A V1 writer never leaves this on a non-dead-letter row. These regression
// cases inject the stale value to prove every later transition clears it.
const AUTOMATION_ADMISSION_UNRESOLVED = {
    v: 1,
    kind: "automationAdmissionUnresolved",
    totalCount: 1,
    entries: [{
        automationId: "automation-stale",
        status: { kind: "blocked", reason: "capacity" },
    }],
    omittedCount: 0,
} as const;
const RELEASE_FACTS = normalizePluginReleaseFactsV1({
    ref: { pluginId: TARGET.materialization.pluginId, version: "1.0.0" },
    archiveDigestSha256: `sha256:${"a".repeat(64)}`,
    normalizedManifest: {
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
    },
    collectionContracts: [],
    uiSlots: [],
    packageAssetArchive: {
        archiveDigestSha256: `sha256:${"d".repeat(64)}`,
        resources: [],
    },
});

describe("plugin webhook claim/lease settlement", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-webhook-claim-store-",
            initAuth: false,
            env: {
                HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID,
                HAPPIER_PUBLIC_SERVER_URL: "https://happier.example",
            },
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

    async function seedDelivery(params: Readonly<{
        id?: string;
        attemptCount?: number;
        state?: "queued" | "claimed";
        executionStartedAt?: Date | null;
        leaseExpiresAt?: Date | null;
        accountMode?: "plain" | "e2ee";
    }> = {}) {
        const accountMode = params.accountMode ?? "plain";
        const account = await db.account.create({
            data: {
                id: "account-claim",
                ...(accountMode === "e2ee"
                    ? createSignedAccountContentBinding()
                    : { publicKey: null }),
                encryptionMode: accountMode,
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: account.id,
                pluginId: TARGET.materialization.pluginId,
                desiredVersion: "1.0.0",
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: account.id,
                pluginId: TARGET.materialization.pluginId,
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
                id: TARGET.materialization.machineId,
                accountId: account.id,
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
                accountId: account.id,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: TARGET.materialization.machineId,
                materializationId: TARGET.materialization.materializationId,
                pluginId: TARGET.materialization.pluginId,
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
                id: "route-claim",
                opaqueRouteId: "opaque-claim",
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
            },
        });
        const endpoint = await db.pluginWebhookEndpoint.create({
            data: {
                id: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                accountId: account.id,
                pluginId: TARGET.materialization.pluginId,
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "source-claim",
                ensureIdempotencyKey: "idempotency-claim-0001",
                ensureRequestFingerprint: "a".repeat(64),
                setupKind: "accountEndpointV1",
                routeId: route.id,
                routingKind: "accountEndpoint",
                targetMachineId: TARGET.materialization.machineId,
                targetMachineInstallationId: TARGET.machineInstallationId,
                targetMaterializationId: TARGET.materialization.materializationId,
                targetPluginVersion: "1.0.0",
            },
        });
        await db.pluginWebhookRoute.update({
            where: { id: route.id },
            data: { accountEndpointId: endpoint.id },
        });
        const state = params.state ?? "queued";
        return await db.pluginWebhookDelivery.create({
            data: {
                id: params.id ?? "delivery-claim",
                endpointId: endpoint.id,
                accountId: account.id,
                routeId: route.id,
                deliveryIdentityDigest: "b".repeat(64),
                verifierKind: "github_hmac_sha256_v1",
                targetMachineId: TARGET.materialization.machineId,
                targetMachineInstallationId: TARGET.machineInstallationId,
                targetMaterializationId: TARGET.materialization.materializationId,
                targetPluginId: TARGET.materialization.pluginId,
                targetPluginVersion: "1.0.0",
                endpointRevision: endpoint.revision,
                endpointWebhookContributionId: "github-events",
                endpointHandlerActionId: "handle-webhook",
                endpointSourceInstanceId: "source-claim",
                payloadKind: "plain",
                payload: ENVELOPE,
                payloadBytes: 256n,
                wireVersion: 1,
                payloadVersion: 1,
                state,
                attemptCount: params.attemptCount ?? 0,
                nextAttemptAt: NOW,
                leaseId: state === "claimed" ? "lease-expired" : null,
                claimedByMachineId: state === "claimed" ? TARGET.materialization.machineId : null,
                claimedByMachineInstallationId: state === "claimed" ? TARGET.machineInstallationId : null,
                firstClaimAt: state === "claimed" ? new Date(NOW.getTime() - 60_000) : null,
                executionStartedAt: params.executionStartedAt ?? null,
                leaseExpiresAt: params.leaseExpiresAt ?? null,
                metadataDeleteAt: new Date(NOW.getTime() + 97 * 24 * 60 * 60 * 1_000),
                receivedAt: NOW,
            },
        });
    }

    async function readWebhookChange() {
        return await db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: "account-claim",
                    kind: "pluginDomain",
                    entityId: "pluginDomain/acme.github/webhook",
                },
            },
            select: { cursor: true, hint: true },
        });
    }

    it("lets only the authenticated exact target claim once, then purges payload on fenced completion", async () => {
        await seedDelivery();
        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: { automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED },
        });

        await expect(claimPluginWebhookDeliveryV1({
            accountId: "wrong-account",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(1),
        })).resolves.toMatchObject({ kind: "none" });

        const [first, second] = await Promise.all([
            claimPluginWebhookDeliveryV1({
                accountId: "account-claim",
                machine: MACHINE_CLAIM,
                now: NOW,
                randomBytes: () => new Uint8Array(16).fill(2),
            }),
            claimPluginWebhookDeliveryV1({
                accountId: "account-claim",
                machine: MACHINE_CLAIM,
                now: NOW,
                randomBytes: () => new Uint8Array(16).fill(3),
            }),
        ]);
        const delivery = [first, second].find((result) => result.kind === "delivery");
        expect([first, second].filter((result) => result.kind === "delivery")).toHaveLength(1);
        expect(delivery).toMatchObject({
            kind: "delivery",
            deliveryId: "delivery-claim",
            attempt: 1,
            replay: 0,
            envelope: ENVELOPE,
        });
        if (!delivery || delivery.kind !== "delivery") throw new Error("expected claimed delivery");
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: delivery.deliveryId } }))
            .resolves.toMatchObject({
                state: "claimed",
                automationAdmissionUnresolved: null,
            });
        const claimedChange = await readWebhookChange();
        expect(claimedChange).toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });

        const started = await renewPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: delivery.deliveryId,
            target: TARGET,
            lease: { leaseId: delivery.lease.leaseId, revision: delivery.lease.revision },
            transition: "executionStarted",
            now: new Date(NOW.getTime() + 1_000),
        });
        expect(started).toMatchObject({ kind: "renewed", revision: delivery.lease.revision + 1 });
        if (started.kind !== "renewed") throw new Error("expected renewed lease");
        const renewedChange = await readWebhookChange();
        expect(renewedChange.cursor).toBeGreaterThan(claimedChange.cursor);

        await expect(completePluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: delivery.deliveryId,
            target: TARGET,
            lease: { leaseId: delivery.lease.leaseId, revision: delivery.lease.revision },
            disposition: "accepted",
            now: new Date(NOW.getTime() + 2_000),
        })).resolves.toEqual({ kind: "leaseLost" });
        await expect(readWebhookChange()).resolves.toEqual(renewedChange);

        await expect(completePluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: delivery.deliveryId,
            target: TARGET,
            lease: { leaseId: delivery.lease.leaseId, revision: started.revision },
            disposition: "accepted",
            now: new Date(NOW.getTime() + 2_000),
        })).resolves.toEqual({ kind: "settled", state: "succeeded" });
        const settledChange = await readWebhookChange();
        expect(settledChange.cursor).toBeGreaterThan(renewedChange.cursor);

        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: delivery.deliveryId } }))
            .resolves.toMatchObject({
                state: "succeeded",
                attemptCount: 1,
                payload: null,
                payloadBytes: 0n,
                leaseId: null,
                terminalDisposition: "accepted",
            });
    });

    it("dead-letters a plain payload before claiming it for an E2EE Account", async () => {
        await seedDelivery({ accountMode: "e2ee" });

        await expect(claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(2),
        })).resolves.toEqual({ kind: "none", retryAfterMs: 5_000 });

        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({
            where: { id: "delivery-claim" },
        })).resolves.toMatchObject({
            state: "dead_letter",
            lastErrorCode: "account_encryption_mismatch",
            payload: ENVELOPE,
            payloadBytes: 256n,
            leaseId: null,
        });
        await expect(readWebhookChange()).resolves.toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
    });

    it("does not offer a queued delivery to an exact materialization that has not published webhook claim support", async () => {
        await seedDelivery();
        await db.machine.update({
            where: {
                accountId_id: {
                    accountId: "account-claim",
                    id: TARGET.materialization.machineId,
                },
            },
            data: {
                operationProtocolCapabilities: {},
                operationProtocolCapabilitiesRevision: 2,
            },
        });

        await expect(claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(9),
        })).resolves.toEqual({ kind: "none", retryAfterMs: 5_000 });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({
            where: { id: "delivery-claim" },
        })).resolves.toMatchObject({
            state: "queued",
            payloadBytes: 256n,
            leaseId: null,
        });
    });

    it("validates exact claimed correspondence while accepting same-lease renewals and rejecting reclaim", async () => {
        await seedDelivery();
        const claimed = await claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(4),
        });
        if (claimed.kind !== "delivery") throw new Error("expected claimed delivery");
        const started = await renewPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: claimed.deliveryId,
            target: TARGET,
            lease: claimed.lease,
            transition: "executionStarted",
            now: new Date(NOW.getTime() + 1_000),
        });
        if (started.kind !== "renewed") throw new Error("expected execution-started renewal");
        const reference = {
            v: 1 as const,
            deliveryId: claimed.deliveryId,
            endpoint: claimed.endpoint,
            target: TARGET,
            lease: { leaseId: claimed.lease.leaseId, revision: claimed.lease.revision },
        };
        const validate = async (candidate: typeof reference) => await inTx(async (tx) => (
            await validateCurrentPluginWebhookInvocationReferenceTxV1({
                tx,
                accountId: "account-claim",
                reference: candidate,
                serverIdentityId: SERVER_IDENTITY_ID,
                now: new Date(NOW.getTime() + 2_000),
            })
        ));

        await expect(validate(reference)).resolves.toEqual({
            kind: "ready",
            webhookEndpointId: claimed.endpoint.webhookEndpointId,
            revision: claimed.endpoint.revision,
            webhookContribution: claimed.endpoint.webhookContribution,
            sourceInstanceId: claimed.endpoint.sourceInstanceId,
            target: TARGET,
        });
        await expect(validate({
            ...reference,
            lease: { ...reference.lease, revision: started.revision + 1 },
        })).resolves.toEqual({ kind: "unavailable", code: "delivery_lease_unavailable" });
        await expect(validate({
            ...reference,
            endpoint: { ...reference.endpoint, sourceInstanceId: "source-spoofed" },
        })).resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });

        await db.pluginWebhookDelivery.update({
            where: { id: claimed.deliveryId },
            data: { leaseId: "lease-reclaimed", revision: { increment: 1 } },
        });
        await expect(validate(reference)).resolves.toEqual({
            kind: "unavailable",
            code: "delivery_lease_unavailable",
        });
    });

    it("keeps an admitted delivery's frozen invocation target and revision through a later retarget without moving it", async () => {
        await seedDelivery();
        await db.machine.create({
            data: {
                id: RETARGETED.materialization.machineId,
                accountId: "account-claim",
                metadata: "{}",
                installationId: RETARGETED.machineInstallationId,
                pluginMaterializationRevision: 1n,
                operationProtocolCapabilities: {
                    pluginWebhookClaim: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: "account-claim",
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: RETARGETED.materialization.machineId,
                materializationId: RETARGETED.materialization.materializationId,
                pluginId: RETARGETED.materialization.pluginId,
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

        await expect(retargetPluginWebhookEndpointV1({
            accountId: "account-claim",
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            expectedRevision: 1,
            idempotencyKey: "retarget-future-admissions-0001",
            target: {
                materialization: RETARGETED.materialization,
                machineInstallationId: RETARGETED.machineInstallationId,
                pluginVersion: "1.0.0",
            },
        })).resolves.toMatchObject({ kind: "retargeted", revision: 2 });

        const claimed = await claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(6),
        });
        if (claimed.kind !== "delivery") throw new Error("expected the pre-retarget delivery to remain claimable by its admitted target");
        expect(claimed.endpoint).toMatchObject({
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            revision: 1,
            webhookContribution: { pluginId: "acme.github", localId: "github-events" },
            handlerActionLocalId: "handle-webhook",
            sourceInstanceId: "source-claim",
        });

        const started = await renewPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: claimed.deliveryId,
            target: TARGET,
            lease: claimed.lease,
            transition: "executionStarted",
            now: new Date(NOW.getTime() + 1_000),
        });
        if (started.kind !== "renewed") throw new Error("expected execution-started renewal");

        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: claimed.deliveryId } }))
            .resolves.toMatchObject({
                state: "claimed",
                revision: started.revision,
                leaseId: claimed.lease.leaseId,
                claimedByMachineId: TARGET.materialization.machineId,
                claimedByMachineInstallationId: TARGET.machineInstallationId,
                executionStartedAt: new Date(NOW.getTime() + 1_000),
                endpointRevision: 1,
                endpointWebhookContributionId: "github-events",
                endpointHandlerActionId: "handle-webhook",
                endpointSourceInstanceId: "source-claim",
                targetMachineId: TARGET.materialization.machineId,
                targetMachineInstallationId: TARGET.machineInstallationId,
                targetMaterializationId: TARGET.materialization.materializationId,
                targetPluginId: TARGET.materialization.pluginId,
            });
        await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({
            where: { id: "wh_ep_AAECAwQFBgcICQoLDA0ODw" },
            include: { route: true },
        })).resolves.toMatchObject({
            revision: 2,
            enabled: true,
            revokedAt: null,
            releasedAt: null,
            routingKind: "accountEndpoint",
            targetMachineId: RETARGETED.materialization.machineId,
            targetMachineInstallationId: RETARGETED.machineInstallationId,
            targetMaterializationId: RETARGETED.materialization.materializationId,
            route: {
                enabled: true,
                revokedAt: null,
                verifierKind: "github_hmac_sha256_v1",
            },
        });
        await expect(inTx(async (tx) => await validateCurrentPluginWebhookInvocationReferenceTxV1({
            tx,
            accountId: "account-claim",
            reference: {
                v: 1,
                deliveryId: claimed.deliveryId,
                endpoint: claimed.endpoint,
                target: TARGET,
                lease: { leaseId: claimed.lease.leaseId, revision: started.revision },
            },
            serverIdentityId: SERVER_IDENTITY_ID,
            now: new Date(NOW.getTime() + 2_000),
        }))).resolves.toEqual({
            kind: "ready",
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            revision: 1,
            webhookContribution: { pluginId: "acme.github", localId: "github-events" },
            sourceInstanceId: "source-claim",
            target: TARGET,
        });

        await expect(completePluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: claimed.deliveryId,
            target: TARGET,
            lease: { leaseId: claimed.lease.leaseId, revision: started.revision },
            disposition: "accepted",
            now: new Date(NOW.getTime() + 3_000),
        })).resolves.toEqual({ kind: "settled", state: "succeeded" });
    });

    it("rejects a claimed endpoint after its webhook contribution is retired from the current manifest", async () => {
        await seedDelivery();
        const claimed = await claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(5),
        });
        if (claimed.kind !== "delivery") throw new Error("expected claimed delivery");
        const started = await renewPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: claimed.deliveryId,
            target: TARGET,
            lease: claimed.lease,
            transition: "executionStarted",
            now: new Date(NOW.getTime() + 1_000),
        });
        if (started.kind !== "renewed") throw new Error("expected execution-started renewal");
        const retiredFacts = normalizePluginReleaseFactsV1({
            ...RELEASE_FACTS,
            normalizedManifest: {
                ...RELEASE_FACTS.normalizedManifest,
                contributes: { actions: RELEASE_FACTS.normalizedManifest.contributes.actions },
            },
        });
        await db.accountPluginRelease.update({
            where: {
                accountId_pluginId_version: {
                    accountId: "account-claim",
                    pluginId: TARGET.materialization.pluginId,
                    version: "1.0.0",
                },
            },
            data: { normalizedManifest: retiredFacts.normalizedManifest },
        });

        await expect(inTx(async (tx) => await validateCurrentPluginWebhookInvocationReferenceTxV1({
            tx,
            accountId: "account-claim",
            reference: {
                v: 1,
                deliveryId: claimed.deliveryId,
                endpoint: claimed.endpoint,
                target: TARGET,
                lease: { leaseId: claimed.lease.leaseId, revision: started.revision },
            },
            serverIdentityId: SERVER_IDENTITY_ID,
            now: new Date(NOW.getTime() + 2_000),
        }))).resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });
    });

    it("recovers expired claims without charging pre-execution loss and dead-letters attempt exhaustion", async () => {
        await seedDelivery({
            state: "claimed",
            leaseExpiresAt: NOW,
            executionStartedAt: null,
        });
        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: { automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED },
        });
        await expect(recoverExpiredPluginWebhookClaimsV1({ now: NOW, batchSize: 100 }))
            .resolves.toEqual({ requeued: 1, deadLettered: 0 });
        const requeuedChange = await readWebhookChange();
        expect(requeuedChange).toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({
                state: "queued",
                attemptCount: 0,
                leaseId: null,
                automationAdmissionUnresolved: null,
            });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({ nextAttemptAt: NOW });

        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: {
                state: "claimed",
                attemptCount: 1,
                leaseId: "lease-execution-started",
                claimedByMachineId: TARGET.materialization.machineId,
                claimedByMachineInstallationId: TARGET.machineInstallationId,
                firstClaimAt: new Date(NOW.getTime() - 60_000),
                executionStartedAt: new Date(NOW.getTime() - 30_000),
                leaseExpiresAt: NOW,
            },
        });
        await expect(recoverExpiredPluginWebhookClaimsV1({ now: NOW, batchSize: 100 }))
            .resolves.toEqual({ requeued: 1, deadLettered: 0 });
        const retried = await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } });
        expect(retried.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());

        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: {
                state: "claimed",
                attemptCount: 12,
                leaseId: "lease-exhausted",
                claimedByMachineId: TARGET.materialization.machineId,
                claimedByMachineInstallationId: TARGET.machineInstallationId,
                firstClaimAt: new Date(NOW.getTime() - 60_000),
                executionStartedAt: new Date(NOW.getTime() - 30_000),
                leaseExpiresAt: NOW,
            },
        });
        await expect(recoverExpiredPluginWebhookClaimsV1({ now: NOW, batchSize: 100 }))
            .resolves.toEqual({ requeued: 0, deadLettered: 1 });
        const deadLetteredChange = await readWebhookChange();
        expect(deadLetteredChange.cursor).toBeGreaterThan(requeuedChange.cursor);
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({ state: "dead_letter", lastErrorCode: "lease_expired", payloadBytes: 256n });
    });

    it("leaves ordinary backlog alone and ages only a target already proven offline", async () => {
        await seedDelivery();
        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: { automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED },
        });

        await expect(ageOverduePluginWebhookDeliveriesV1({ now: NOW, batchSize: 100 })).resolves.toEqual({
            deadLettered: 0,
        });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({
                state: "queued",
                attemptCount: 0,
                offlineSinceAt: null,
                lastErrorCode: null,
                automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED,
            });

        const offlineSinceAt = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1_000);
        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: {
                offlineSinceAt,
                lastErrorCode: "target_offline",
            },
        });

        await expect(ageOverduePluginWebhookDeliveriesV1({ now: NOW, batchSize: 100 })).resolves.toEqual({
            deadLettered: 1,
        });
        const deadLetteredChange = await readWebhookChange();
        expect(deadLetteredChange).toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({ state: "dead_letter", attemptCount: 0, lastErrorCode: "target_offline" });
    });

    it("expires never-claimed custody through the indexed epoch horizon and releases payload quota", async () => {
        await seedDelivery();
        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: { metadataDeleteAt: NOW },
        });

        await expect(ageOverduePluginWebhookDeliveriesV1({ now: NOW, batchSize: 100 })).resolves.toEqual({
            deadLettered: 1,
        });
        const deadLetter = await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } });
        expect(deadLetter).toMatchObject({
            state: "dead_letter",
            attemptCount: 0,
            lastErrorCode: "retention_expired",
            payloadBytes: 256n,
        });
        expect(deadLetter.payloadPurgeAt?.toISOString()).toBe("2026-09-09T00:00:00.000Z");
        expect(deadLetter.metadataDeleteAt.toISOString()).toBe("2026-11-08T00:00:00.000Z");

        await expect(purgeExpiredPluginWebhookDeliveriesV1({
            now: new Date("2026-09-09T00:00:00.000Z"),
            batchSize: 100,
        })).resolves.toEqual({
            payloadsPurged: 1,
            metadataDeleted: 0,
            tombstonesDeleted: 0,
        });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({ state: "dead_letter", payload: null, payloadBytes: 0n });
        await expect(db.pluginWebhookDelivery.aggregate({
            where: { accountId: "account-claim", payloadBytes: { gt: 0n } },
            _sum: { payloadBytes: true },
        })).resolves.toMatchObject({ _sum: { payloadBytes: null } });

        await expect(purgeExpiredPluginWebhookDeliveriesV1({
            now: new Date("2026-11-08T00:00:00.000Z"),
            batchSize: 100,
        })).resolves.toEqual({
            payloadsPurged: 0,
            metadataDeleted: 1,
            tombstonesDeleted: 0,
        });
        await expect(db.pluginWebhookDelivery.findUnique({ where: { id: "delivery-claim" } })).resolves.toBeNull();
    });

    it("schedules bounded retry under the current lease and rejects a stale fail", async () => {
        await seedDelivery();
        const claimed = await claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(4),
        });
        if (claimed.kind !== "delivery") throw new Error("expected claimed delivery");
        const started = await renewPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: claimed.deliveryId,
            target: TARGET,
            lease: claimed.lease,
            transition: "executionStarted",
            now: new Date(NOW.getTime() + 1_000),
        });
        if (started.kind !== "renewed") throw new Error("expected execution start");
        const beforeFail = await readWebhookChange();

        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: claimed.deliveryId,
            target: TARGET,
            lease: { leaseId: claimed.lease.leaseId, revision: started.revision },
            result: { kind: "retry", code: "provider_busy" },
            now: new Date(NOW.getTime() + 2_000),
            retryDelayMs: 5_000,
        })).resolves.toEqual({ kind: "settled", state: "queued" });
        const queued = await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: claimed.deliveryId } });
        expect(queued).toMatchObject({ state: "queued", attemptCount: 1, lastErrorCode: "provider_busy" });
        expect(queued.nextAttemptAt.toISOString()).toBe("2026-08-10T00:00:07.000Z");
        expect((await readWebhookChange()).cursor).toBeGreaterThan(beforeFail.cursor);
    });

    it("persists the host-private unresolved Automation summary only when a retry exhausts the claimed delivery", async () => {
        await seedDelivery({
            attemptCount: 11,
            state: "claimed",
            executionStartedAt: new Date(NOW.getTime() - 1_000),
            leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        });
        const firstSummary = {
            v: 1 as const,
            kind: "automationAdmissionUnresolved" as const,
            totalCount: 1,
            entries: [{
                automationId: "automation-first",
                status: { kind: "blocked" as const, reason: "capacity" as const },
            }],
            omittedCount: 0,
        };
        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: { automationAdmissionUnresolved: firstSummary },
        });

        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: "delivery-claim",
            target: TARGET,
            lease: { leaseId: "lease-expired", revision: 0 },
            result: { kind: "retry", code: "github.automation-unavailable" },
            automationAdmissionUnresolved: firstSummary,
            now: NOW,
            retryDelayMs: 5_000,
        })).resolves.toEqual({ kind: "settled", state: "queued" });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({
                state: "queued",
                attemptCount: 11,
                automationAdmissionUnresolved: null,
            });

        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: {
                state: "claimed",
                attemptCount: 12,
                leaseId: "lease-exhausted",
                claimedByMachineId: TARGET.materialization.machineId,
                claimedByMachineInstallationId: TARGET.machineInstallationId,
                firstClaimAt: new Date(NOW.getTime() - 60_000),
                executionStartedAt: new Date(NOW.getTime() - 1_000),
                leaseExpiresAt: new Date(NOW.getTime() + 60_000),
            },
        });
        const currentSummary = {
            v: 1 as const,
            kind: "automationAdmissionUnresolved" as const,
            totalCount: 2,
            entries: [
                {
                    automationId: "automation-current-a",
                    status: { kind: "refreshDefinition" as const, reason: "definitionStale" as const },
                },
                {
                    automationId: "automation-current-b",
                    status: { kind: "blocked" as const, reason: "temporarilyUnavailable" as const },
                },
            ],
            omittedCount: 0,
        };
        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: "delivery-claim",
            target: TARGET,
            lease: { leaseId: "lease-expired", revision: 0 },
            result: { kind: "retry", code: "github.automation-unavailable" },
            automationAdmissionUnresolved: currentSummary,
            now: NOW,
            retryDelayMs: 5_000,
        })).resolves.toEqual({ kind: "leaseLost" });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({
                state: "claimed",
                automationAdmissionUnresolved: null,
            });
        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: "delivery-claim",
            target: TARGET,
            lease: { leaseId: "lease-exhausted", revision: 1 },
            result: { kind: "retry", code: "github.automation-unavailable" },
            automationAdmissionUnresolved: currentSummary,
            now: NOW,
            retryDelayMs: 5_000,
        })).resolves.toEqual({ kind: "settled", state: "dead_letter" });
        const exhausted = await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } });
        expect(exhausted.state).toBe("dead_letter");
        expect(exhausted.automationAdmissionUnresolved).toEqual(currentSummary);
    });

    it("projects the exhaustion-only unresolved Automation summary through the incumbent Account status reader", async () => {
        await seedDelivery({
            attemptCount: 12,
            state: "claimed",
            executionStartedAt: new Date(NOW.getTime() - 1_000),
            leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        });
        const summary = {
            v: 1 as const,
            kind: "automationAdmissionUnresolved" as const,
            totalCount: 2,
            entries: [
                {
                    automationId: "automation-current-a",
                    status: { kind: "refreshDefinition" as const, reason: "definitionStale" as const },
                },
                {
                    automationId: "automation-current-b",
                    status: { kind: "blocked" as const, reason: "temporarilyUnavailable" as const },
                },
            ],
            omittedCount: 0,
        };

        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: "delivery-claim",
            target: TARGET,
            lease: { leaseId: "lease-expired", revision: 0 },
            result: { kind: "retry", code: "github.automation-unavailable" },
            automationAdmissionUnresolved: summary,
            now: NOW,
            retryDelayMs: 5_000,
        })).resolves.toEqual({ kind: "settled", state: "dead_letter" });

        await expect(readPluginWebhookAccountStatusV1({
            accountId: "account-claim",
            input: { pageSize: 100, deadLetterPageSize: 100 },
        })).resolves.toMatchObject({
            deadLetters: [{
                deliveryId: "delivery-claim",
                errorCode: "github.automation-unavailable",
                attemptCount: 12,
                automationAdmissionUnresolved: summary,
            }],
        });
    });

    it("clears a stale unresolved Automation summary for a deliberate dead-letter classification", async () => {
        await seedDelivery({
            state: "claimed",
            executionStartedAt: new Date(NOW.getTime() - 1_000),
            leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        });
        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: { automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED },
        });

        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-claim",
            deliveryId: "delivery-claim",
            target: TARGET,
            lease: { leaseId: "lease-expired", revision: 0 },
            result: { kind: "deadLetter", code: "payload_invalid" },
            now: NOW,
        })).resolves.toEqual({ kind: "settled", state: "dead_letter" });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({
                state: "dead_letter",
                automationAdmissionUnresolved: null,
            });
    });

    it("tracks target unavailability without charging an attempt and dead-letters after seven days", async () => {
        await seedDelivery();
        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-claim" },
            data: { automationAdmissionUnresolved: AUTOMATION_ADMISSION_UNRESOLVED },
        });
        await db.pluginMachineMaterialization.updateMany({
            where: { accountId: "account-claim", materializationId: TARGET.materialization.materializationId },
            data: { enabled: false },
        });

        await expect(claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(5),
        })).resolves.toMatchObject({ kind: "none" });
        const offlineChange = await readWebhookChange();
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({
                state: "queued",
                attemptCount: 0,
                offlineSinceAt: NOW,
                automationAdmissionUnresolved: null,
            });

        const expiredAt = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1_000 + 1);
        await expect(claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: expiredAt,
            randomBytes: () => new Uint8Array(16).fill(6),
        })).resolves.toMatchObject({ kind: "none" });
        expect((await readWebhookChange()).cursor).toBeGreaterThan(offlineChange.cursor);
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({
                state: "dead_letter",
                attemptCount: 0,
                lastErrorCode: "target_offline",
            });
    });

    it("one machine claim selects one exact eligible target and returns its exact authority", async () => {
        await seedDelivery();

        const claimed = await claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(7),
        });
        expect(claimed).toMatchObject({
            kind: "delivery",
            deliveryId: "delivery-claim",
            target: TARGET,
            pluginVersion: "1.0.0",
            endpoint: {
                webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                revision: 1,
                webhookContribution: { pluginId: "acme.github", localId: "github-events" },
                handlerActionLocalId: "handle-webhook",
                sourceInstanceId: "source-claim",
            },
        });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-claim" } }))
            .resolves.toMatchObject({
                state: "claimed",
                claimedByMachineId: MACHINE_CLAIM.machineId,
                claimedByMachineInstallationId: MACHINE_CLAIM.machineInstallationId,
            });
    });

    it("marks one stale head offline before the next claim reaches the eligible target", async () => {
        await seedDelivery();
        await db.pluginWebhookDelivery.create({
            data: {
                id: "delivery-stale",
                endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                accountId: "account-claim",
                routeId: "route-claim",
                deliveryIdentityDigest: "c".repeat(64),
                verifierKind: "github_hmac_sha256_v1",
                targetMachineId: TARGET.materialization.machineId,
                targetMachineInstallationId: TARGET.machineInstallationId,
                targetMaterializationId: "materialization-stale",
                targetPluginId: TARGET.materialization.pluginId,
                targetPluginVersion: "1.0.0",
                endpointRevision: 1,
                endpointWebhookContributionId: "github-events",
                endpointHandlerActionId: "handle-webhook",
                endpointSourceInstanceId: "source-claim",
                payloadKind: "plain",
                payload: ENVELOPE,
                payloadBytes: 256n,
                wireVersion: 1,
                payloadVersion: 1,
                state: "queued",
                nextAttemptAt: new Date(NOW.getTime() - 1_000),
                metadataDeleteAt: new Date(NOW.getTime() + 97 * 24 * 60 * 60 * 1_000),
                receivedAt: new Date(NOW.getTime() - 1_000),
            },
        });

        // One claim examines exactly one due head. It records the stale target's
        // offline transition and returns none; the next wake then reaches the
        // eligible exact target behind it.
        await expect(claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: NOW,
            randomBytes: () => new Uint8Array(16).fill(8),
        })).resolves.toMatchObject({ kind: "none" });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: "delivery-stale" } }))
            .resolves.toMatchObject({
                state: "queued",
                attemptCount: 0,
                offlineSinceAt: NOW,
                lastErrorCode: "target_offline",
            });

        await expect(claimPluginWebhookDeliveryV1({
            accountId: "account-claim",
            machine: MACHINE_CLAIM,
            now: new Date(NOW.getTime() + 5_000),
            randomBytes: () => new Uint8Array(16).fill(9),
        })).resolves.toMatchObject({
            kind: "delivery",
            deliveryId: "delivery-claim",
            target: TARGET,
            pluginVersion: "1.0.0",
        });
    });
});
