import { randomUUID } from 'node:crypto';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { managedGithubEndpointKey, revokePluginWebhookEndpointV1 } from './endpointStore';
import { removeUnusedManagedRepositoryWebhook } from './removeUnusedManagedRepositoryWebhook';
import { updateAutomationTrigger } from '@/app/automations/automationCrudService';
import { removeAdmittedDeploymentEnvironmentInTx } from '@/app/deployments/deploymentDispositionService';
import { sourceFromRow } from '@/app/projects/sources/projectSourceService';
import type { ForwardManagedPluginWebhookOperation } from '@/app/api/socket/managedPluginWebhookDispatcher';
import { GITHUB_EVENT_SETUP_ACTIONS_V1, GITHUB_MANAGED_PREVIEW_EVENT_LOCAL_ID_V1 } from '@happier-dev/protocol/automations/event-setup-result';
import { createHmac } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const emitUpdate = vi.hoisted(() => vi.fn());

vi.mock("@/app/events/connectionEventRouter", () => ({
    eventRouter: { emitUpdate },
}));

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
import { ingestPluginWebhookV1, type PluginWebhookIngestDependenciesV1 } from "./ingest";
import { createPluginWebhookStoredEnvelopeV1 } from "./storedEnvelope";
import { emitPluginWebhookDeliveryCommittedWakeV1 } from "./wake";

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
            () => db.automationTrigger.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.deploymentEnvironment.deleteMany(),
            () => db.projectSource.deleteMany(),
            () => db.artifact.deleteMany(),
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
        // Durable admission rechecks that the verified request's credential is
        // still one this route accepts, so the fixture must own the credential
        // version `admissionParams()` presents.
        const currentCredential = await db.pluginWebhookCredential.create({
            data: {
                routeId: route.id,
                credentialVersionId: "credential-1",
                verifierKind: "github_hmac_sha256_v1",
                encryptedSecret: new Uint8Array([1]),
                state: "current",
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
                setupKind: "accountEndpointV1",
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
            data: { accountEndpointId: endpoint.id, currentCredentialId: currentCredential.id },
        });
        return { account, route, endpoint };
    }

    async function seedAdditionalTarget(
        machineId: string,
        installationId: string,
        materializationId: string,
    ) {
        await db.machine.create({
            data: {
                id: machineId,
                accountId: "account-delivery",
                metadata: "{}",
                installationId,
                pluginMaterializationRevision: 1n,
                operationProtocolCapabilities: { pluginWebhookClaim: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: "account-delivery",
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId,
                materializationId,
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
    }

    async function moveEndpointTarget(params: Readonly<{
        revision: number;
        previous: Readonly<{ machineId: string; machineInstallationId: string; materializationId: string }>;
        next: Readonly<{ machineId: string; machineInstallationId: string; materializationId: string }>;
    }>) {
        await db.pluginWebhookEndpoint.update({
            where: { id: "wh_ep_AAECAwQFBgcICQoLDA0ODw" },
            data: {
                previousTargetMachineId: params.previous.machineId,
                previousTargetMachineInstallationId: params.previous.machineInstallationId,
                previousTargetMaterializationId: params.previous.materializationId,
                previousTargetPluginVersion: "1.0.0",
                targetMachineId: params.next.machineId,
                targetMachineInstallationId: params.next.machineInstallationId,
                targetMaterializationId: params.next.materializationId,
                targetPluginVersion: "1.0.0",
                revision: params.revision,
            },
        });
    }

    function admissionParams(endpointRevision = 1) {
        return {
            endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            expectedEndpointRevision: endpointRevision,
            routeId: "route-delivery",
            verifierKind: "github_hmac_sha256_v1" as const,
            credentialVersionId: "credential-1",
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

    async function seedManagedWebhook() {
        const { account, route, endpoint } = await seedCurrentTarget();
        await db.pluginWebhookEndpoint.update({
            where: { id: endpoint.id },
            data: { ensureIdempotencyKey: managedGithubEndpointKey("42"),
                sourceInstanceId: "github:repository:42", providerRepositoryHookId: "123" },
        });
        const automationId = "managed-automation";
        const eventRef = { pluginId: "acme.github", localId: "push" };
        const triggerRows = ["managed-trigger-first", "managed-trigger-last"].map(id => {
            const sourceSelectorId = randomUUID();
            const definitionEnvelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, automationId, triggerId: id, triggerRevision: 0,
                    triggerKind: "pluginEvent", eventRef, sourceSelectorId },
                definition: { v: 1, sourceInstanceId: "github:repository:42", sourceConfig: {}, displayLabel: "example/app",
                    filter: null, maximumObservationAgeMs: null },
            });
            return { id, kind: "pluginEvent" as const, eventPluginId: eventRef.pluginId, eventLocalId: eventRef.localId,
                sourceSelectorId, sourceContractVersion: 1, definitionEnvelope: JSON.stringify(definitionEnvelope),
                webhookEndpointId: endpoint.id, observationTransport: "checkpointedPull",
                watcherMachineId: "machine-1", watcherMachineInstallationId: "installation-1",
                watcherPluginId: "acme.github", watcherMaterializationId: "materialization-1" };
        });
        const automation = await db.automation.create({
            data: { id: automationId, accountId: account.id, name: "Deploy", templateCiphertext: "{}",
                triggers: { create: triggerRows } },
            include: { triggers: true },
        });
        return { account, route, endpoint, triggers: automation.triggers };
    }

    it.each(["removed", "unavailable"] as const)("retires the route after the last consumer even when GitHub removal is %s", async (outcome) => {
        const { account, route, triggers: [first, last] } = await seedManagedWebhook();
        let deleted = 0;
        const remove = (consumer: typeof first) => removeUnusedManagedRepositoryWebhook({
            accountId: account.id, consumer,
            async forward({ operation }) {
                expect(operation).toMatchObject({ kind: "remove", hookId: "123", repositoryId: "42" });
                expect(await db.pluginWebhookRoute.findUnique({ where: { id: route.id } })).toMatchObject({ enabled: true });
                deleted++;
                return outcome === "removed" ? { kind: "removed" }
                    : { kind: "unavailable", code: "github_webhook_removal_refused" };
            },
        });
        await db.automationTrigger.delete({ where: { id: first.id } });
        await expect(remove(first)).resolves.toEqual({ kind: "retained" });
        expect(deleted).toBe(0);
        await db.automationTrigger.delete({ where: { id: last.id } });
        await expect(remove(last)).resolves.toEqual(outcome === "removed" ? { kind: "removed" }
            : { kind: "unavailable", code: "github_webhook_removal_refused" });
        expect(await db.pluginWebhookRoute.findUnique({ where: { id: route.id } })).toMatchObject({ enabled: false });
        await expect(remove(last)).resolves.toEqual({ kind: "retained" });
        expect(deleted).toBe(1);
    });

    it("removes the preview webhook after the Environment tombstone commits", async () => {
        const { account, endpoint, triggers } = await seedManagedWebhook();
        const project = await db.projectSource.create({ data: {
            name: 'Preview app', createdByAccountId: account.id, audience: [], attachments: [],
        } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: account.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: project.id,
            createdByAccountId: account.id, controllerMachineId: 'machine-1', protection: 'production',
            purpose: 'standard', deployerMode: 'managers', contentArtifactId: artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1 } });
        await db.automation.update({ where: { id: triggers[0].automationId }, data: {
            deploymentEnvironmentId: environment.id, deploymentPreviewRole: 'preview_admission',
        } });
        const eventRef = { pluginId: GITHUB_EVENT_SETUP_ACTIONS_V1.pluginId, localId: GITHUB_MANAGED_PREVIEW_EVENT_LOCAL_ID_V1 };
        const now = new Date();
        for (const trigger of triggers) {
            const definitionEnvelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: 'plain', binding: { v: 1, automationId: trigger.automationId, triggerId: trigger.id,
                    triggerRevision: trigger.revision, triggerKind: 'pluginEvent', eventRef, sourceSelectorId: trigger.sourceSelectorId! },
                definition: { v: 1, sourceInstanceId: 'github:repository:42', sourceConfig: {}, displayLabel: 'example/app',
                    filter: null, maximumObservationAgeMs: null },
            });
            await db.automationTrigger.update({ where: { id: trigger.id }, data: {
                eventPluginId: eventRef.pluginId, eventLocalId: eventRef.localId, definitionEnvelope: JSON.stringify(definitionEnvelope),
            } });
        }
        const source = sourceFromRow(project);
        if (!source.success) throw source.error;
        const operations: unknown[] = [];
        const forwardManagedWebhook: ForwardManagedPluginWebhookOperation = async ({ operation, target }) => {
            operations.push({ operation, target,
                deleted: (await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).deletedAt });
            return { kind: 'removed' };
        };
        const revision = await inTx(tx => removeAdmittedDeploymentEnvironmentInTx(tx, {
            environment, source: source.data, now, forwardManagedWebhook,
        }));
        expect(revision).toBe(environment.revision + 1);
        await vi.waitFor(async () => {
            expect(await db.pluginWebhookEndpoint.findUnique({ where: { id: endpoint.id } })).toMatchObject({ enabled: false });
        });
        expect(operations).toEqual([{
            operation: expect.objectContaining({ kind: 'remove', hookId: '123', repositoryId: '42' }),
            target: { accountId: account.id, machineId: 'machine-1', installationId: 'installation-1' },
            deleted: now,
        }]);
    });

    it("retires a managed route when editing its last polling trigger clears the attachment", async () => {
        const { account, route, endpoint, triggers: [first, last] } = await seedManagedWebhook();
        await db.automationTrigger.delete({ where: { id: first.id } });
        const consumers: Parameters<typeof removeUnusedManagedRepositoryWebhook>[0]["consumer"][] = [];
        const mutation = {
            accountId: account.id, automationId: last.automationId, triggerId: last.id,
            expectedRevision: last.revision, enabled: false,
            trigger: { kind: "schedule", schedule: { kind: "interval", scheduleExpr: null, everyMs: 60_000, timezone: null } },
            onDeletedWebhookConsumer: (consumer: typeof last) => consumers.push(consumer),
        } as const;
        const result = await updateAutomationTrigger(mutation);
        expect(result?.triggers.find(trigger => trigger.id === last.id)).toMatchObject({ webhookEndpointId: null });
        for (const consumer of consumers) {
            await removeUnusedManagedRepositoryWebhook({ accountId: account.id, consumer,
                async forward() { return { kind: "removed" }; } });
        }
        expect(await db.pluginWebhookEndpoint.findUnique({ where: { id: endpoint.id } })).toMatchObject({ enabled: false });
        expect(await db.pluginWebhookRoute.findUnique({ where: { id: route.id } })).toMatchObject({ enabled: false });
    });

    it("lets the owner manually retire a managed route with no live consumer", async () => {
        const { account, route, endpoint, triggers } = await seedManagedWebhook();
        await db.automationTrigger.deleteMany({
            where: { id: { in: triggers.map(trigger => trigger.id) } },
        });
        await revokePluginWebhookEndpointV1({ accountId: account.id, webhookEndpointId: endpoint.id,
            expectedRevision: endpoint.revision, idempotencyKey: "manual-recovery" });
        expect(await db.pluginWebhookRoute.findUnique({ where: { id: route.id } })).toMatchObject({ enabled: false });
    });

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
            metadataDeleteAt: new Date("2026-08-17T00:00:00.000Z"),
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

    it.each([false, true])("routes verified ingress through durable admission (managed GitHub hook: %s)", async (managed) => {
        const { account, endpoint } = await seedCurrentTarget();
        const triggerId = "managed-trigger";
        if (managed) {
            await db.pluginWebhookEndpoint.update({
                where: { id: endpoint.id }, data: { providerRepositoryHookId: "42" },
            });
            await db.automation.create({ data: {
                id: "managed-automation", accountId: account.id, name: "Deploy", templateCiphertext: "{}",
                triggers: { create: {
                    id: triggerId, kind: "pluginEvent", eventPluginId: "acme.github", eventLocalId: "push",
                    sourceSelectorId: "managed-source", sourceContractVersion: 1, observationTransport: "checkpointedPull",
                    webhookEndpointId: endpoint.id, definitionEnvelope: "{}",
                    watcherMachineId: "machine-1", watcherMachineInstallationId: "installation-1",
                    watcherPluginId: "acme.github", watcherMaterializationId: "materialization-1",
                } },
            } });
        }
        emitUpdate.mockClear();
        const rawBody = Uint8Array.from(Buffer.from('{"action":"opened"}', "utf8"));
        const signature = `sha256=${createHmac("sha256", "ingress-secret").update(rawBody).digest("hex")}`;
        const dependencies: PluginWebhookIngestDependenciesV1 = {
            findRoute: vi.fn(async () => ({
                routeId: "route-delivery",
                verifierKind: "github_hmac_sha256_v1" as const,
                routingKind: "accountEndpoint" as const,
                policyVersion: 1 as const,
            })),
            readCredentials: vi.fn(async () => [{ credentialVersionId: "credential-1", secret: "ingress-secret" }]),
            parseInstallationId: vi.fn(() => null),
            resolveEndpoint: vi.fn(async () => ({
                endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                revision: 1,
                accountId: "account-delivery",
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "source-1",
                routingKind: "accountEndpoint" as const,
                providerInstallationId: null,
                targetMaterialization: {
                    machineId: "machine-1",
                    materializationId: "materialization-1",
                    pluginId: "acme.github",
                },
                targetMachineInstallationId: "installation-1",
                targetPluginVersion: "1.0.0",
            })),
            readAccount: async (accountId) => await db.account.findUnique({
                where: { id: accountId },
                select: {
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            }),
            admitDelivery: admitPluginWebhookDeliveryV1,
        };

        const send = (delivery: string, hookId: string, deliverySignature = signature) => ingestPluginWebhookV1({
            opaqueRouteId: "opaque-delivery",
            rawBody,
            headers: {
                "x-hub-signature-256": deliverySignature,
                "x-github-delivery": delivery,
                "x-github-hook-id": hookId,
                "x-github-event": "issues",
                "content-type": "application/json",
            },
            now: NOW,
            onCommittedWake: emitPluginWebhookDeliveryCommittedWakeV1,
            dependencies,
        });
        const readTrigger = () => db.automationTrigger.findUniqueOrThrow({ where: { id: triggerId } });
        if (managed) {
            await send("invalid-signature", "42", `sha256=${"0".repeat(64)}`);
            expect(await readTrigger()).toMatchObject({ observationTransport: "checkpointedPull", watcherMachineId: "machine-1" });
            await send("wrong-hook", "99");
            expect(await readTrigger()).toMatchObject({ observationTransport: "checkpointedPull", watcherMachineId: "machine-1" });
            expect(await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } }))
                .toMatchObject({ providerConfirmedAt: null });
        }
        const accepted = await send("delivery-guid-ingress-wake-1", "42");
        expect(accepted).toMatchObject({ kind: "accepted", duplicate: false });
        if (managed) {
            expect(await readTrigger()).toMatchObject({ observationTransport: "durablePush", watcherMachineId: null,
                watcherMachineInstallationId: null, watcherMaterializationId: null, watcherPluginId: null });
        }
        if (accepted.kind !== "accepted") throw new Error("Signed webhook delivery was not admitted");
        const row = await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { id: accepted.deliveryId } });
        const change = await readWebhookChange();
        expect(row).toMatchObject({
            accountId: "account-delivery",
            targetMachineId: "machine-1",
            targetMaterializationId: "materialization-1",
            state: "queued",
        });
        expect(emitUpdate).toHaveBeenCalledWith({
            userId: "account-delivery",
            payload: expect.objectContaining({
                seq: change.cursor,
                body: { t: "account-change" },
            }),
            recipientFilter: { type: "machine-only", machineId: "machine-1" },
        });
        expect(emitUpdate.mock.calls.filter(([event]) => (
            (event as Readonly<{ recipientFilter?: Readonly<{ type?: string; machineId?: string }> }>).recipientFilter?.type
            === "machine-only"
            && (event as Readonly<{ recipientFilter?: Readonly<{ type?: string; machineId?: string }> }>).recipientFilter?.machineId
            === "machine-1"
        ))).toHaveLength(1);
    });

    it("reobserves a duplicate without mutating payload, target, attempts, or wake state", async () => {
        await seedCurrentTarget();
        const wake = vi.fn();
        const first = await admitPluginWebhookDeliveryV1({ ...admissionParams(), onCommittedWake: wake });
        const before = await db.pluginWebhookDelivery.findUniqueOrThrow({ where: { deliveryIdentityDigest: "a".repeat(64) } });
        const admittedChange = await readWebhookChange();

        // The ingress transaction rechecks the endpoint binding revision before
        // it resolves the unique dedupe conflict, and ingest always presents the
        // revision it just read, so a duplicate arrives at the current revision.
        await expect(admitPluginWebhookDeliveryV1({ ...admissionParams(), onCommittedWake: wake }))
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
            await acquireAccountEncryptionTransitionFenceInTx(tx, "account-delivery", "exclusive");
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

    it("moves every stale frozen target after the endpoint moved twice, not only the immediately prior one", async () => {
        // A -> B -> C. The row admitted while the endpoint pointed at A is as
        // stranded as the one admitted at B: neither will ever be claimed,
        // because claim only grants work frozen to a currently claimable
        // target. Selecting by the endpoint's *immediately prior* target would
        // silently leave the A row behind with no second operation able to
        // reach it.
        await seedCurrentTarget();
        await expect(admitPluginWebhookDeliveryV1(admissionParams())).resolves.toMatchObject({ kind: "admitted" });
        await seedAdditionalTarget("machine-2", "installation-2", "materialization-2");
        await moveEndpointTarget({
            revision: 2,
            previous: { machineId: "machine-1", machineInstallationId: "installation-1", materializationId: "materialization-1" },
            next: { machineId: "machine-2", machineInstallationId: "installation-2", materializationId: "materialization-2" },
        });
        await expect(admitPluginWebhookDeliveryV1({
            ...admissionParams(2),
            deliveryIdentityDigest: "b".repeat(64),
        })).resolves.toMatchObject({ kind: "admitted" });
        await seedAdditionalTarget("machine-3", "installation-3", "materialization-3");
        await moveEndpointTarget({
            revision: 3,
            previous: { machineId: "machine-2", machineInstallationId: "installation-2", materializationId: "materialization-2" },
            next: { machineId: "machine-3", machineInstallationId: "installation-3", materializationId: "materialization-3" },
        });

        await expect(movePendingPluginWebhookDeliveriesV1({
            accountId: "account-delivery",
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            endpointRevision: 3,
            targetMaterialization: {
                machineId: "machine-3",
                materializationId: "materialization-3",
                pluginId: "acme.github",
            },
        })).resolves.toEqual({ moved: 2, skippedClaimed: 0, nextCursor: null, done: true });
        await expect(db.pluginWebhookDelivery.count({
            where: {
                targetMachineId: "machine-3",
                targetMachineInstallationId: "installation-3",
                targetMaterializationId: "materialization-3",
                targetPluginVersion: "1.0.0",
            },
        })).resolves.toBe(2);
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
