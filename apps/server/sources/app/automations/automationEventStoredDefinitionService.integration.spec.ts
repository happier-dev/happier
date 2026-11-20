import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    AutomationRunExecutionRecipeV1Schema,
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    normalizePluginReleaseFactsV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    sealAccountScopedBlobCiphertext,
    type AutomationTriggerId,
} from "@happier-dev/protocol";
import { createPluginEventAutomationSetupResultV1JsonSchema } from "@happier-dev/protocol/automations/event-setup-result";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { logger } from "@/utils/logging/log";
import { withWebLatencyTrace } from "@/utils/webLatencyTrace";
import { ensureAutomationEventCatalogStateTx } from "./automationCrudService";
import { transitionDeploymentInTx } from '@/app/deployments/deploymentService';
import { computeDeploymentTransitionRequestDigestV1, type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import nacl from 'tweetnacl';
import { setDeploymentEnvironmentControllerInTx } from '@/app/deployments/deploymentControllerService';
import { unlinkDeploymentTargetInTx } from '@/app/deployments/deploymentDispositionService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentInTx, updateDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDeploymentEnvironmentV1 } from '@happier-dev/deployments/testing/v1';
import * as privacyKit from 'privacy-kit';

import {
    AutomationEventStoredDefinitionsReadError,
    readAutomationEventStoredDefinitionsV1,
} from "./automationEventStoredDefinitionService";

const ACCOUNT_ID = "account-automation-stored-definitions";
const MACHINE_ID = "machine-automation-stored-definitions";
const MACHINE_INSTALLATION_ID = "installation-automation-stored-definitions";
const MATERIALIZATION_ID = "materialization-automation-stored-definitions";
const SERVER_IDENTITY_ID = "srv_automationStoredDefinitionsCurrent1";
const PLUGIN_ID = "com.acme.github";
const PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const DURABLE_PUSH_ENDPOINT_ID = "wh_ep_AAECAwQFBgcICQoLDA0ODw";
const SETUP_ACTION_LOCAL_ID = "setup-repository-source";
const SOURCE_CONFIG_SCHEMA = { type: "object", additionalProperties: false } as const;

const caller = {
    pluginId: PLUGIN_ID,
    machineId: MACHINE_ID,
    machineInstallationId: MACHINE_INSTALLATION_ID,
    materializationId: MATERIALIZATION_ID,
    sourceCustody: {
        kind: "managed",
        immutableGenerationId: "github-stored-definition-generation-a",
        installSource: "archive",
    },
} as const;

/** The one canonical trigger-identity fixture builder; branded at the boundary. */
function triggerId(index: number): AutomationTriggerId {
    return AutomationTriggerIdSchema.parse(`automation-trigger-${String(index).padStart(4, "0")}`);
}

function sourceSelector(index: number) {
    return AutomationSourceSelectorIdV1Schema.parse(
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
}

function releaseFacts(params: Readonly<{
    supportedObservationTransports?: readonly ("checkpointedPull" | "durablePush" | "socket")[];
}> = {}) {
    const supportedObservationTransports = params.supportedObservationTransports ?? ["checkpointedPull"];
    const supportsDurablePush = supportedObservationTransports.includes("durablePush");
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            displayName: "Stored definition fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: "./dist/index.js" },
            contributes: {
                actions: [{
                    id: SETUP_ACTION_LOCAL_ID,
                    title: "Set up repository source",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                    execution: { target: "daemon" },
                    inputSchema: SOURCE_CONFIG_SCHEMA,
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, SOURCE_CONFIG_SCHEMA),
                }, ...(supportsDurablePush ? [{
                    id: "receive-repository-events",
                    title: "Receive repository events",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                    execution: { target: "daemon" },
                }] : [])],
                events: [{
                    id: EVENT_LOCAL_ID,
                    kind: "event",
                    title: "Repository event",
                    payloadSchema: { type: "object", additionalProperties: false },
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion: 1,
                            supportedObservationTransports,
                            ...(supportsDurablePush ? {
                                webhookContributionRef: {
                                    pluginId: PLUGIN_ID,
                                    localId: "repository-events",
                                },
                            } : {}),
                            sourceConfigSchema: SOURCE_CONFIG_SCHEMA,
                            setupActionRef: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
                        },
                    },
                }],
                webhooks: supportsDurablePush ? [{
                    id: "repository-events",
                    title: "Repository events",
                    verifier: { kind: "github_hmac_sha256_v1", routing: "accountEndpoint" },
                    handlerAction: { localId: "receive-repository-events" },
                }] : [],
            },
        },
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"d".repeat(64)}`,
            resources: [],
        },
    });
}

function automationDefinition(index: number) {
    const id = `automation-${String(index).padStart(4, "0")}`;
    return {
        id,
        accountId: ACCOUNT_ID,
        name: `Observe repository ${index}`,
        enabled: true,
        targetType: "new_session" as const,
        templateCiphertext: JSON.stringify(AutomationRunExecutionRecipeV1Schema.parse({
            v: 1,
            templateVersion: index,
            assignmentMachineIds: [],
            template: { t: "plain", v: { v: 1, prompt: "observe" } },
            triggerEvidence: null,
            target: {
                kind: "newSession",
                spawn: {
                    executionTarget: { serverId: "server", machineId: "machine" },
                    directory: { kind: "path", path: "/tmp/automation-stored-definition" },
                    agentTarget: {
                        kind: "agent",
                        identity: { pluginId: "happier.agent.codex", localId: "codex" },
                    },
                },
            },
        })),
        templateVersion: index,
    };
}

function automationTrigger(index: number) {
    const automationId = `automation-${String(index).padStart(4, "0")}`;
    const id = triggerId(index);
    return {
        id,
        automationId,
        kind: "pluginEvent" as const,
        enabled: true,
        revision: index,
        eventPluginId: PLUGIN_ID,
        eventLocalId: EVENT_LOCAL_ID,
        sourceSelectorId: sourceSelector(index),
        sourceContractVersion: 1,
        observationTransport: "checkpointedPull" as const,
        watcherMachineId: MACHINE_ID,
        watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
        watcherPluginId: PLUGIN_ID,
        watcherMaterializationId: MATERIALIZATION_ID,
        definitionEnvelope: JSON.stringify(
            sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: "plain",
                binding: {
                    v: 1,
                    automationId,
                    triggerId: id,
                    triggerRevision: index,
                    triggerKind: "pluginEvent",
                    eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                    sourceSelectorId: sourceSelector(index),
                },
                definition: {
                    v: 1,
                    sourceInstanceId: `repository-${index}`,
                    sourceConfig: { repositoryId: index },
                    displayLabel: `Repository ${index}`,
                    filter: null,
                    maximumObservationAgeMs: null,
                },
            }),
        ),
    };
}

describe("Automation Event stored-definition projection", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-stored-definitions-",
            initAuth: false,
            initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID, HAPPIER_WEB_LATENCY_TRACE: "1" },
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        harness?.resetEnv();
        await harness?.resetDbTables([
            () => db.automationEventSourceCatalogStatus.deleteMany(),
            () => db.automationEventSourceStatus.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.pluginWebhookDelivery.deleteMany(),
            () => db.pluginWebhookEndpoint.deleteMany(),
            () => db.pluginWebhookRoute.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.deploymentEnvironment.updateMany({ data: { runtimeTargetLinkId: null } }),
            () => db.deployment.deleteMany(),
            () => db.deploymentTargetLinkMachine.deleteMany(),
            () => db.deploymentTargetLink.deleteMany(),
            () => db.deploymentEnvironmentDeployer.deleteMany(),
            () => db.deploymentEnvironment.deleteMany(),
            () => db.projectSource.deleteMany(),
            () => db.artifact.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
        await db.account.deleteMany();
    });

    async function seed(definitionCount: number, catalogRevision: bigint | null = 7n): Promise<void> {
        const release = releaseFacts();
        await db.account.create({
            data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" },
        });
        await db.machine.create({
            data: {
                id: MACHINE_ID,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: MACHINE_INSTALLATION_ID,
                pluginMaterializationRevision: 1n,
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: PLUGIN_VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                archiveDigestSha256: release.archiveDigestSha256,
                normalizedManifest: release.normalizedManifest,
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: release.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: MATERIALIZATION_ID,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: release.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-10T00:00:00.000Z"),
            },
        });
        await db.automation.createMany({
            data: Array.from({ length: definitionCount }, (_, index) => automationDefinition(index + 1)),
        });
        await db.automationTrigger.createMany({
            data: Array.from({ length: definitionCount }, (_, index) => automationTrigger(index + 1)),
        });
        if (catalogRevision !== null) {
            await db.automationEventCatalogState.create({
                data: { accountId: ACCOUNT_ID, eventSourceDefinitionsRevision: catalogRevision },
            });
        }
    }

    it.each(['unlink', 'leave production', 'leave production with prepared placement', 'teardown'] as const)('moves the same Environment source without resealing and applies the next catalog boundary on %s', async withdrawal => {
        await seed(1);
        const changesProtection = withdrawal === 'leave production' || withdrawal === 'leave production with prepared placement';
        const publishedMachine = { metadata: encodePlainMachineStoredContent({ host: 'Controller', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) };
        await db.machine.update({ where: { id: MACHINE_ID }, data: publishedMachine });
        const source = await inTx(tx => createProjectSourceInTx(tx, ACCOUNT_ID, {
            serverId: SERVER_IDENTITY_ID, requestKey: crypto.randomUUID(), name: 'Observed platform', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const content = createDeploymentEnvironmentV1().content;
        if (content.t !== 'plain') throw new Error('Expected plain Environment fixture');
        const artifact = await createArtifact({ actorUserId: ACCOUNT_ID, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Observed platform' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content.v) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const reference = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, ACCOUNT_ID, { ...reference,
            serverId: SERVER_IDENTITY_ID, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'production', purpose: 'standard', deployerMode: 'managers', controllerMachineId: MACHINE_ID }));
        if (!created.ok) throw new Error(created.error);
        const environmentId = created.environmentId;
        const link = await db.deploymentTargetLink.create({ data: { ...reference, environmentId,
            createdByAccountId: ACCOUNT_ID, role: 'runtime', state: 'configured',
            ...(changesProtection
                ? { sourceKind: 'plugin', pluginId: PLUGIN_ID, contributionLocalId: 'runtime', targetKind: 'platform' }
                : { sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', machines: { create: {
                    machineId: MACHINE_ID, installationId: MACHINE_INSTALLATION_ID, position: 0, state: 'active' } } }) } });
        await db.deploymentEnvironment.update({ where: { id: environmentId }, data: { runtimeTargetLinkId: link.id } });
        await db.automation.update({ where: { id: 'automation-0001' }, data: { targetType: null, deploymentEnvironmentId: environmentId,
            templateCiphertext: JSON.stringify({ kind: 'observationOnly', templateVersion: 1, deploymentEnvironment: {
                serverId: SERVER_IDENTITY_ID, environmentId, projectSourceId: source.source.id } }) } });
        const read = (reader: Parameters<typeof readAutomationEventStoredDefinitionsV1>[0]['caller'] = caller) => readAutomationEventStoredDefinitionsV1({ accountId: ACCOUNT_ID, caller: reader,
            input: { transport: { kind: 'checkpointedPull' }, pageSize: 10 } });
        expect(await read()).toMatchObject({ kind: 'page', definitions: [{ automationId: 'automation-0001' }] });
        const before = await db.automationTrigger.findUniqueOrThrow({ where: { id: triggerId(1) } });
        const nextMachineId = 'controller-next';
        const nextInstallationId = 'installation-next';
        await db.machine.create({ data: { id: nextMachineId, accountId: ACCOUNT_ID, ...publishedMachine,
            installationId: nextInstallationId, pluginMaterializationRevision: 1n } });
        const oldMaterialization = await db.pluginMachineMaterialization.findFirstOrThrow({ where: { machineId: MACHINE_ID } });
        const { id: _oldId, ...materialization } = oldMaterialization;
        const unavailable = await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, ACCOUNT_ID, {
            serverId: SERVER_IDENTITY_ID, environmentId, expectedRevision: created.revision, controllerMachineId: nextMachineId }));
        expect(unavailable).toMatchObject({ ok: true });
        expect(await db.automationTrigger.findUniqueOrThrow({ where: { id: triggerId(1) } })).toEqual({ ...before,
            watcherMachineId: null, watcherMachineInstallationId: null,
            watcherPluginId: null, watcherMaterializationId: null });
        expect(await read()).toMatchObject({ kind: 'page', definitions: [] });
        if (!unavailable.ok) throw new Error('Expected unavailable watcher handoff');
        await db.pluginMachineMaterialization.create({ data: { ...materialization, machineId: nextMachineId } });
        const moved = await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, ACCOUNT_ID, {
            serverId: SERVER_IDENTITY_ID, environmentId, expectedRevision: unavailable.revision, controllerMachineId: nextMachineId }));
        expect(moved).toMatchObject({ ok: true });
        const after = await db.automationTrigger.findUniqueOrThrow({ where: { id: triggerId(1) } });
        expect(after).toEqual({ ...before, watcherMachineId: nextMachineId, watcherMachineInstallationId: nextInstallationId });
        expect(await read()).toMatchObject({ kind: 'page', definitions: [] });
        const nextCaller = { ...caller, machineId: nextMachineId, machineInstallationId: nextInstallationId };
        expect(await read(nextCaller)).toMatchObject({ kind: 'page', definitions: [{ automationId: 'automation-0001', triggerRevision: 1 }] });
        if (!moved.ok) throw new Error('Expected controller move');
        let withdrawn;
        if (withdrawal === 'teardown') {
            const keys = nacl.sign.keyPair();
            await db.machine.update({ where: { id: nextMachineId }, data: { installationPublicKey: new Uint8Array(keys.publicKey) } });
            const receipt = await db.deployment.create({ data: { ...reference, environmentId, targetLinkId: link.id,
                operation: 'teardown', state: 'running', requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
                requestedByAccountId: ACCOUNT_ID, acceptedControllerMachineId: nextMachineId,
                acceptedControllerInstallationId: nextInstallationId } });
            const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId: SERVER_IDENTITY_ID, environmentId,
                deploymentId: receipt.id, actionOperationId: receipt.actionOperationId, expectedRevision: receipt.revision,
                machineId: nextMachineId, installationId: nextInstallationId, kind: 'settle', state: 'succeeded',
                teardownProof: { targetLinkRevision: link.revision, machines: [{ machineId: MACHINE_ID, installationId: MACHINE_INSTALLATION_ID }],
                    workloadAbsent: true, retainedProviderResource: false,
                    steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] } };
            const proof = signMachineInstallationProof({ payload: { version: 1, machineId: nextMachineId,
                installationId: nextInstallationId, accountId: ACCOUNT_ID, deploymentTransition: { serverId: SERVER_IDENTITY_ID,
                    environmentId, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
                    expectedRevision: receipt.revision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey });
            withdrawn = await inTx(tx => transitionDeploymentInTx(tx, ACCOUNT_ID, { ...body, proof }));
        } else withdrawn = withdrawal === 'unlink'
            ? await inTx(tx => unlinkDeploymentTargetInTx(tx, ACCOUNT_ID, { serverId: SERVER_IDENTITY_ID,
                environmentId, expectedRevision: moved.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
                requestKey: crypto.randomUUID(), detachKeepRunning: true }))
            : await inTx(tx => updateDeploymentEnvironmentInTx(tx, ACCOUNT_ID, { ...reference, serverId: SERVER_IDENTITY_ID,
                environmentId, expectedRevision: moved.revision,
                patch: { protection: 'nonProduction', ...(withdrawal === 'leave production with prepared placement'
                    ? { buildMachineId: nextMachineId } : {}) },
                ...(withdrawal === 'leave production with prepared placement'
                    ? { preparedBindings: { grants: [], referencedSavedSecretRevisions: [] } } : {}) }));
        expect(withdrawn).toMatchObject({ ok: true });
        if (changesProtection) {
            expect(await read(nextCaller)).toMatchObject({ kind: 'page', definitions: [{ automationId: 'automation-0001', triggerRevision: 1 }] });
            expect(await db.automationTrigger.findUniqueOrThrow({ where: { id: triggerId(1) } })).toEqual(after);
            expect(await db.automation.findUniqueOrThrow({ where: { id: 'automation-0001' } })).toMatchObject({ enabled: true });
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } })).toMatchObject({
                protection: 'nonProduction', controllerMachineId: nextMachineId });
            if (!withdrawn.ok) throw new Error('Expected protection update');
            expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, ACCOUNT_ID, { serverId: SERVER_IDENTITY_ID,
                environmentId, expectedRevision: withdrawn.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
                requestKey: crypto.randomUUID(), detachKeepRunning: true }))).toMatchObject({ ok: true });
        }
        expect(await read(nextCaller)).toMatchObject({ kind: 'page', definitions: [] });
    });

    async function seedCurrentDurablePushEndpoint(): Promise<void> {
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: "route-automation-stored-definitions",
                opaqueRouteId: "opaque-automation-stored-definitions",
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
            },
        });
        const endpoint = await db.pluginWebhookEndpoint.create({
            data: {
                id: DURABLE_PUSH_ENDPOINT_ID,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                webhookContributionId: "repository-events",
                handlerActionId: "receive-repository-events",
                sourceInstanceId: "endpoint-routing-repository",
                ensureIdempotencyKey: "automation-stored-definitions-endpoint-key",
                ensureRequestFingerprint: "a".repeat(64),
                setupKind: "accountEndpointV1",
                routeId: route.id,
                routingKind: "accountEndpoint",
                targetMachineId: MACHINE_ID,
                targetMachineInstallationId: MACHINE_INSTALLATION_ID,
                targetMaterializationId: MATERIALIZATION_ID,
                targetPluginVersion: PLUGIN_VERSION,
            },
        });
        await db.pluginWebhookRoute.update({
            where: { id: route.id },
            data: { accountEndpointId: endpoint.id },
        });
    }

    async function seedCurrentDurablePushDelivery() {
        const now = new Date();
        await db.machine.update({
            where: { accountId_id: { accountId: ACCOUNT_ID, id: MACHINE_ID } },
            data: {
                operationProtocolCapabilities: {
                    pluginWebhookClaim: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        await seedCurrentDurablePushEndpoint();
        const endpoint = await db.pluginWebhookEndpoint.findUniqueOrThrow({
            where: { id: DURABLE_PUSH_ENDPOINT_ID },
            select: { id: true, revision: true, routeId: true },
        });
        const leaseId = "wh_lease_AAECAwQFBgcICQoLDA0ODw";
        await db.pluginWebhookDelivery.create({
            data: {
                id: "delivery-automation-stored-definitions",
                endpointId: endpoint.id,
                accountId: ACCOUNT_ID,
                routeId: endpoint.routeId,
                deliveryIdentityDigest: "b".repeat(64),
                verifierKind: "github_hmac_sha256_v1",
                targetMachineId: MACHINE_ID,
                targetMachineInstallationId: MACHINE_INSTALLATION_ID,
                targetMaterializationId: MATERIALIZATION_ID,
                targetPluginId: PLUGIN_ID,
                targetPluginVersion: PLUGIN_VERSION,
                endpointRevision: endpoint.revision,
                endpointWebhookContributionId: "repository-events",
                endpointHandlerActionId: "receive-repository-events",
                endpointSourceInstanceId: "endpoint-routing-repository",
                payloadKind: "plain",
                payload: { t: "plain", v: {} },
                payloadBytes: 2n,
                wireVersion: 1,
                payloadVersion: 1,
                state: "claimed",
                nextAttemptAt: now,
                leaseId,
                claimedByMachineId: MACHINE_ID,
                claimedByMachineInstallationId: MACHINE_INSTALLATION_ID,
                firstClaimAt: now,
                executionStartedAt: now,
                leaseExpiresAt: new Date(now.getTime() + 120_000),
                revision: 1,
                metadataDeleteAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
                receivedAt: now,
            },
        });
        return {
            v: 1,
            deliveryId: "delivery-automation-stored-definitions",
            endpoint: {
                webhookEndpointId: endpoint.id,
                revision: endpoint.revision,
                webhookContribution: { pluginId: PLUGIN_ID, localId: "repository-events" },
                handlerActionLocalId: "receive-repository-events",
                sourceInstanceId: "endpoint-routing-repository",
            },
            target: {
                materialization: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                    pluginId: PLUGIN_ID,
                },
                machineInstallationId: MACHINE_INSTALLATION_ID,
            },
            lease: { leaseId, revision: 1 },
        } as const;
    }

    it("initializes an uncreated catalog once so an empty observer can park and later see its first source", async () => {
        await seed(0, null);
        const read = (knownRevision?: string) => readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" }, ...(knownRevision === undefined ? {} : { knownRevision }) },
        });
        const previousLogLevel = logger.level;
        logger.level = "trace";
        const catalogOperations: string[] = [];
        const trace = vi.spyOn(logger, "trace").mockImplementation((record: unknown) => {
            if (typeof record === "object" && record !== null && "phase" in record
                && typeof record.phase === "string" && record.phase.startsWith("db.AutomationEventCatalogState.")) {
                catalogOperations.push(record.phase);
            }
        });
        try {
            await expect(withWebLatencyTrace("req-initialeventcatalog", () => read()))
                .resolves.toMatchObject({ kind: "page", revision: "0", definitions: [], nextCursor: null });
            expect(catalogOperations).toEqual([
                "db.AutomationEventCatalogState.findUnique",
                "db.AutomationEventCatalogState.upsert",
            ]);
        } finally {
            trace.mockRestore();
            logger.level = previousLogLevel;
        }
        await expect(read("0")).resolves.toMatchObject({ kind: "unchanged", revision: "0" });
        expect(await db.automationEventCatalogState.findUnique({ where: { accountId: ACCOUNT_ID } }))
            .toMatchObject({ eventSourceDefinitionsRevision: 0n });
        await inTx(async tx => {
            await tx.automation.create({ data: automationDefinition(1) });
            await tx.automationTrigger.create({ data: automationTrigger(1) });
            await ensureAutomationEventCatalogStateTx({ tx, accountId: ACCOUNT_ID, projectionChanged: true });
        });
        await expect(read("0")).resolves.toMatchObject({ kind: "page", revision: "1", nextCursor: null,
            definitions: [{ triggerId: triggerId(1) }] });
        await expect(read("1")).resolves.toMatchObject({ kind: "unchanged", revision: "1" });
    });

    it("does not initialize an uncreated catalog for a refused watcher", async () => {
        await seed(0, null);
        await db.machine.update({ where: { id: MACHINE_ID }, data: { kind: "ephemeral_session_runner" } });
        await expect(readAutomationEventStoredDefinitionsV1({ accountId: ACCOUNT_ID, caller,
            input: { transport: { kind: "checkpointedPull" } } }))
            .rejects.toMatchObject({ code: "caller_materialization_not_current" });
        expect(await db.automationEventCatalogState.findUnique({ where: { accountId: ACCOUNT_ID } })).toBeNull();
    });

    it("rejects an ephemeral watcher before disclosing stored definitions", async () => {
        await seed(1);
        await db.machine.update({ where: { id: MACHINE_ID }, data: { kind: "ephemeral_session_runner" } });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" } },
        })).rejects.toMatchObject({ code: "caller_materialization_not_current" });
    });

    it("uses revision-bound keyset pages to disclose only the exact materialization's opaque stored envelopes", async () => {
        await seed(501);

        const first = await readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" }, pageSize: 500 },
        });
        expect(first).toMatchObject({
            kind: "page",
            revision: "7",
            eventDeclarationRelease: {
                release: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
                archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            },
            nextCursor: expect.any(String),
        });
        if (first.kind !== "page") throw new Error("expected the first private page");
        expect(first.definitions).toHaveLength(500);
        expect(first.definitions[0]).toMatchObject({
            automationId: "automation-0001",
            triggerId: triggerId(1),
            triggerRevision: 1,
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: sourceSelector(1),
            storedDefinitionEnvelope: { t: "plain" },
        });
        expect(first.definitions[0]).not.toHaveProperty("sourceInstanceId");
        expect(first.definitions[0]).not.toHaveProperty("sourceConfig");
        expect(first.definitions[0]).not.toHaveProperty("filter");

        const second = await readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                transport: { kind: "checkpointedPull" },
                pageSize: 500,
                cursor: first.nextCursor!,
            },
        });
        expect(second).toMatchObject({
            kind: "page",
            revision: "7",
            nextCursor: null,
            definitions: [{
                automationId: "automation-0501",
                triggerId: triggerId(501),
                triggerRevision: 501,
            }],
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" }, knownRevision: "7" },
        })).resolves.toMatchObject({
            kind: "unchanged",
            revision: "7",
            eventDeclarationRelease: {
                release: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
                archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            },
            scope: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        });

        await db.automationEventCatalogState.update({
            where: { accountId: ACCOUNT_ID },
            data: { eventSourceDefinitionsRevision: 8n },
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                transport: { kind: "checkpointedPull" },
                pageSize: 500,
                cursor: first.nextCursor!,
            },
        })).resolves.toEqual({ kind: "cursorStale", currentRevision: "8" });

        await db.automationTrigger.update({
            where: { id: triggerId(1) },
            data: { watcherMaterializationId: "materialization-moved" },
        });
        await db.automationEventCatalogState.update({
            where: { accountId: ACCOUNT_ID },
            data: { eventSourceDefinitionsRevision: 9n },
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" }, pageSize: 1 },
        })).resolves.toMatchObject({
            kind: "page",
            revision: "9",
            definitions: [{ automationId: "automation-0002" }],
        });
    });

    it("lists every matching Event trigger without choosing one trigger from an Automation", async () => {
        await seed(1);
        const secondTriggerId = AutomationTriggerIdSchema.parse("automation-trigger-0001-second");
        const secondSelector = sourceSelector(92);
        await db.automationTrigger.create({
            data: {
                ...automationTrigger(1),
                id: secondTriggerId,
                revision: 2,
                sourceSelectorId: secondSelector,
                definitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                    mode: "plain",
                    binding: {
                        v: 1,
                        automationId: "automation-0001",
                        triggerId: secondTriggerId,
                        triggerRevision: 2,
                        triggerKind: "pluginEvent",
                        eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                        sourceSelectorId: secondSelector,
                    },
                    definition: {
                        v: 1,
                        sourceInstanceId: "repository-92",
                        sourceConfig: { repositoryId: 92 },
                        displayLabel: "Repository 92",
                        filter: null,
                        maximumObservationAgeMs: null,
                    },
                })),
            },
        });

        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" } },
        })).resolves.toMatchObject({
            kind: "page",
            definitions: [{
                automationId: "automation-0001",
                triggerId: triggerId(1),
                triggerRevision: 1,
            }, {
                automationId: "automation-0001",
                triggerId: secondTriggerId,
                triggerRevision: 2,
            }],
        });
    });

    it("classifies only retired checkpoint identities at one unchanged catalog revision", async () => {
        await seed(6);
        await db.accountPluginRelease.update({
            where: { accountId_pluginId_version: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID, version: PLUGIN_VERSION } },
            data: { normalizedManifest: releaseFacts({ supportedObservationTransports: ["checkpointedPull", "durablePush"] }).normalizedManifest },
        });
        await seedCurrentDurablePushEndpoint();
        await db.automationTrigger.updateMany({
            where: { id: { in: [triggerId(4), triggerId(6)] } },
            data: {
                observationTransport: "durablePush", webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                observationStartsAt: new Date(1_723_247_200_000),
                watcherMachineId: null, watcherMachineInstallationId: null,
                watcherPluginId: null, watcherMaterializationId: null,
            },
        });
        const eventRef = { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID } as const;
        const candidates = [
            {
                automationId: "automation-absent",
                triggerId: "automation-trigger-absent",
                triggerRevision: 1,
                eventRef,
                sourceSelectorId: sourceSelector(91),
                sourceContractVersion: 1,
            },
            {
                automationId: "automation-0001",
                triggerId: triggerId(1),
                triggerRevision: 1,
                eventRef,
                sourceSelectorId: sourceSelector(1),
                sourceContractVersion: 1,
            },
            {
                automationId: "automation-0002",
                triggerId: triggerId(2),
                triggerRevision: 2,
                eventRef,
                sourceSelectorId: sourceSelector(2),
                sourceContractVersion: 1,
            },
            {
                automationId: "automation-0003",
                triggerId: triggerId(3),
                triggerRevision: 3,
                eventRef,
                sourceSelectorId: sourceSelector(3),
                sourceContractVersion: 1,
            },
            {
                automationId: "automation-0004",
                triggerId: triggerId(4),
                triggerRevision: 4,
                eventRef,
                sourceSelectorId: sourceSelector(4),
                sourceContractVersion: 1,
            },
            {
                automationId: "automation-0005",
                triggerId: triggerId(5),
                triggerRevision: 5,
                eventRef,
                sourceSelectorId: sourceSelector(5),
                sourceContractVersion: 1,
            },
            {
                automationId: "automation-0004",
                triggerId: triggerId(4),
                triggerRevision: 4,
                eventRef,
                sourceSelectorId: sourceSelector(94),
                sourceContractVersion: 1,
            },
            {
                automationId: "automation-0006",
                triggerId: triggerId(6),
                triggerRevision: 6,
                eventRef,
                sourceSelectorId: sourceSelector(6),
                sourceContractVersion: 1,
            },
        ] as const;
        await db.automation.update({
            where: { id: "automation-0001" },
            data: { enabled: false, deletedAt: new Date("2026-08-19T00:00:00.000Z") },
        });
        await db.automationTrigger.update({
            where: { id: triggerId(2) },
            data: { sourceSelectorId: sourceSelector(92) },
        });
        await db.automationTrigger.update({
            where: { id: triggerId(3) },
            data: { sourceContractVersion: 2 },
        });
        await db.automation.update({
            where: { id: "automation-0004" },
            data: { enabled: false },
        });
        await db.automationRun.create({
            data: {
                id: "run-retains-soft-deleted-automation",
                automationId: "automation-0005",
                accountId: ACCOUNT_ID,
                state: "failed",
                triggerId: triggerId(5),
                causeKind: "trigger",
                causeTriggerKind: "pluginEvent",
                causeTriggerRevision: 5,
                causeOccurredAt: new Date("2026-08-18T00:00:00.000Z"),
                occurrenceKey: "event-retains-deleted-trigger",
                causeEventPluginId: PLUGIN_ID,
                causeEventLocalId: EVENT_LOCAL_ID,
                causeSourceSelectorId: sourceSelector(5),
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                scheduledAt: new Date("2026-08-18T00:00:00.000Z"),
                dueAt: new Date("2026-08-18T00:00:00.000Z"),
                finishedAt: new Date("2026-08-18T00:01:00.000Z"),
                errorCode: "retained_test_run",
            },
        });
        await db.automationTrigger.delete({ where: { id: triggerId(5) } });

        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                transport: { kind: "checkpointedPull" },
                knownRevision: "7",
                checkpointRetirementCandidates: candidates,
            },
        })).resolves.toMatchObject({
            kind: "unchanged",
            revision: "7",
            eventDeclarationRelease: {
                release: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
                archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            },
            checkpointRetirements: [
                candidates[0],
                candidates[1],
                candidates[2],
                candidates[3],
                candidates[5],
                candidates[6],
            ],
        });

        await db.automationEventCatalogState.update({
            where: { accountId: ACCOUNT_ID },
            data: { eventSourceDefinitionsRevision: 8n },
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                transport: { kind: "checkpointedPull" },
                knownRevision: "7",
                checkpointRetirementCandidates: [candidates[0]],
            },
        })).resolves.toEqual({ kind: "cursorStale", currentRevision: "8" });
    });

    it("projects durable-push envelopes only through the current generic endpoint target", async () => {
        await seed(1);
        const durableRelease = releaseFacts({ supportedObservationTransports: ["durablePush"] });
        await db.accountPluginRelease.update({
            where: {
                accountId_pluginId_version: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    version: PLUGIN_VERSION,
                },
            },
            data: { normalizedManifest: durableRelease.normalizedManifest },
        });
        const webhookInvocationReference = await seedCurrentDurablePushDelivery();
        await db.automationTrigger.update({
            where: { id: triggerId(1) },
            data: {
                observationTransport: "durablePush",
                webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                observationStartsAt: new Date(1_723_247_200_000),
                watcherMachineId: null,
                watcherMachineInstallationId: null,
                watcherPluginId: null,
                watcherMaterializationId: null,
                definitionEnvelope: JSON.stringify(
                    sealAutomationTriggerDefinitionStoredEnvelopeV1({
                        mode: "plain",
                        binding: {
                            v: 1,
                            automationId: "automation-0001",
                            triggerId: triggerId(1),
                            triggerRevision: 1,
                            triggerKind: "pluginEvent",
                            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                            sourceSelectorId: sourceSelector(1),
                        },
                        definition: {
                            v: 1,
                            sourceInstanceId: "repository-private-source",
                            webhookRoutingSourceInstanceId: "endpoint-routing-repository",
                            sourceConfig: { repositoryId: 1 },
                            displayLabel: "Repository 1",
                            filter: null,
                            maximumObservationAgeMs: null,
                        },
                    }),
                ),
            },
        });

        const initial = await readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "durablePush" } },
        });
        expect(initial).toMatchObject({
            kind: "page",
            revision: "7",
            scope: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
            definitions: [{
                automationId: "automation-0001",
                observationTransport: {
                    kind: "durablePush",
                    webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                    endpointMaterializationRef: {
                        pluginId: PLUGIN_ID,
                        machineId: MACHINE_ID,
                        materializationId: MATERIALIZATION_ID,
                    },
                    observationStartsAt: 1_723_247_200_000,
                },
                storedDefinitionEnvelope: { t: "plain" },
            }],
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "durablePush" } },
            webhookInvocationReference,
        })).resolves.toMatchObject({
            kind: "page",
            revision: "7",
            definitions: [{ automationId: "automation-0001" }],
        });
        const initialScope = (initial as Readonly<{ scope?: string }>).scope;

        for (const unavailable of [
            { enabled: false },
            { enabled: true, revokedAt: new Date() },
        ]) {
            await db.pluginWebhookEndpoint.update({
                where: { id: DURABLE_PUSH_ENDPOINT_ID },
                data: unavailable,
            });
            await expect(readAutomationEventStoredDefinitionsV1({
                accountId: ACCOUNT_ID,
                caller,
                input: { transport: { kind: "durablePush" } },
            })).resolves.toMatchObject({
                kind: "page", definitions: [{ automationId: "automation-0001" }],
            });
            await expect(readAutomationEventStoredDefinitionsV1({
                accountId: ACCOUNT_ID, caller,
                input: { transport: { kind: "durablePush" } },
                webhookInvocationReference,
            })).rejects.toMatchObject({ code: "durable_push_endpoint_context_unavailable" });
        }
        await db.pluginWebhookEndpoint.update({
            where: { id: DURABLE_PUSH_ENDPOINT_ID }, data: { enabled: true, revokedAt: null },
        });
        await db.pluginWebhookRoute.update({
            where: { accountEndpointId: DURABLE_PUSH_ENDPOINT_ID }, data: { enabled: false, revokedAt: new Date() },
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID, caller, input: { transport: { kind: "durablePush" } },
        })).resolves.toMatchObject({ kind: "page", definitions: [{ automationId: "automation-0001" }] });

        await db.automationTrigger.update({ where: { id: triggerId(1) }, data: { enabled: false } });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID, caller, input: { transport: { kind: "durablePush" } },
        })).resolves.toMatchObject({ kind: "page", definitions: [] });
        await db.automationTrigger.update({ where: { id: triggerId(1) }, data: { enabled: true } });

        await db.pluginWebhookEndpoint.update({
            where: { id: DURABLE_PUSH_ENDPOINT_ID },
            data: { targetMaterializationId: "materialization-moved" },
        });
        const moved = await readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "durablePush" } },
        });
        expect(moved).toMatchObject({
            kind: "page",
            scope: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
            definitions: [],
        });
        expect((moved as Readonly<{ scope?: string }>).scope).not.toBe(initialScope);
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "durablePush" } },
            webhookInvocationReference,
        })).rejects.toMatchObject({
            code: "durable_push_endpoint_context_unavailable",
        });
    });

    it("projects session-socket envelopes only through the exact assigned watcher", async () => {
        await seed(1);
        const socketRelease = releaseFacts({ supportedObservationTransports: ["socket"] });
        await db.accountPluginRelease.update({
            where: {
                accountId_pluginId_version: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    version: PLUGIN_VERSION,
                },
            },
            data: { normalizedManifest: socketRelease.normalizedManifest },
        });
        await db.automationTrigger.update({
            where: { id: triggerId(1) },
            data: { observationTransport: "socket" },
        });

        const socketPage = await readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "socket" } },
        });
        expect(socketPage).toMatchObject({
            kind: "page",
            revision: "7",
            scope: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
            definitions: [{
                automationId: "automation-0001",
                observationTransport: {
                    kind: "socket",
                    watcherMaterializationRef: {
                        pluginId: PLUGIN_ID,
                        machineId: MACHINE_ID,
                        materializationId: MATERIALIZATION_ID,
                    },
                },
                storedDefinitionEnvelope: { t: "plain" },
            }],
        });

        // The checkpointed-pull scope must not serve socket triggers: a
        // checkpointed observer pulling under the pull scope would falsely
        // claim checkpoint coverage the session-socket source cannot provide.
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" } },
        })).resolves.toMatchObject({ kind: "page", definitions: [] });

        // The assigned watcher is exact: a different watcher materialization
        // of the same plugin sees nothing.
        await db.automationTrigger.update({
            where: { id: triggerId(1) },
            data: { watcherMachineId: "machine-other" },
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "socket" } },
        })).resolves.toMatchObject({ kind: "page", definitions: [] });
    });

    it("fails closed before disclosure when Account mode and a stored definition envelope disagree", async () => {
        await seed(1);
        const encrypted = sealAccountScopedBlobCiphertext({
            kind: "automation_trigger_definition",
            material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) },
            payload: { v: 1 },
            randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
        });
        await db.automationTrigger.update({
            where: { id: triggerId(1) },
            data: { definitionEnvelope: JSON.stringify({ t: "encrypted", c: encrypted }) },
        });

        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" } },
        })).rejects.toMatchObject(
            new AutomationEventStoredDefinitionsReadError("definition_content_unavailable"),
        );
    });
});
