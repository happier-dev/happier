import {
    AutomationRunExecutionRecipeV1Schema,
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationSourceSelectorIdV1Schema,
    normalizePluginReleaseFactsV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    PluginWebhookEndpointEnsureInputV1Schema,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { eventRouter } from "@/app/events/eventRouter";
import { ensurePluginWebhookEndpointV1 } from "@/app/plugins/webhooks/endpointStore";

import { createAutomation, updateAutomation } from "./automationCrudService";
import { AutomationValidationError } from "./automationValidation";

const SERVER_IDENTITY_ID = "srv_automationDurablePush1";
const PLUGIN_ID = "com.acme.push-writer";
const PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const WEBHOOK_LOCAL_ID = "repository-webhook";
const HANDLER_ACTION_LOCAL_ID = "receive-repository-webhook";
const MACHINE_ID = "push-writer-machine";
const MACHINE_INSTALLATION_ID = "push-writer-installation";
const MATERIALIZATION_ID = "push-writer-materialization";
const ROUTING_SOURCE_INSTANCE_ID = "github:installation:2200";

const MATERIALIZATION_REF = {
    machineId: MACHINE_ID,
    materializationId: MATERIALIZATION_ID,
    pluginId: PLUGIN_ID,
} as const;

const RESOLVED_TARGET = {
    materialization: MATERIALIZATION_REF,
    machineInstallationId: MACHINE_INSTALLATION_ID,
    pluginVersion: PLUGIN_VERSION,
} as const;

const RESOLVED_CONTRIBUTION = {
    pluginId: PLUGIN_ID,
    localId: WEBHOOK_LOCAL_ID,
    handlerActionLocalId: HANDLER_ACTION_LOCAL_ID,
    verifierKind: "github_hmac_sha256_v1" as const,
    routingKind: "accountEndpoint" as const,
};

const NEW_SESSION_TARGET = {
    kind: "newSession",
    spawn: {
        executionTarget: { serverId: "server", machineId: MACHINE_ID },
        directory: "/tmp/automation-durable-push",
        agentTarget: {
            kind: "agent",
            identity: { pluginId: "happier.agent.codex", localId: "codex" },
        },
    },
} as const;

function executionRecipe(templateVersion: number) {
    return AutomationRunExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: `Push recipe ${templateVersion}` } },
        triggerEvidence: null,
        target: NEW_SESSION_TARGET,
    });
}

function releaseFacts(params: Readonly<{ supportsDurablePush: boolean }>) {
    const { supportsDurablePush } = params;
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"b".repeat(64)}`,
            resources: [],
        },
        normalizedManifest: {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            displayName: "Durable push fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: "./dist/index.js" },
            contributes: {
                actions: [{
                    id: HANDLER_ACTION_LOCAL_ID,
                    title: "Receive repository webhook",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                    execution: { target: "daemon" },
                }],
                events: [{
                    id: EVENT_LOCAL_ID,
                    kind: "event",
                    title: "Repository event",
                    payloadSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: { action: { type: "string" } },
                        required: ["action"],
                    },
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion: 1,
                            supportedObservationTransports: supportsDurablePush
                                ? ["checkpointedPull", "durablePush"]
                                : ["checkpointedPull"],
                            ...(supportsDurablePush
                                ? {
                                    webhookContributionRef: {
                                        pluginId: PLUGIN_ID,
                                        localId: WEBHOOK_LOCAL_ID,
                                    },
                                }
                                : {}),
                            sourceConfigSchema: {
                                type: "object",
                                properties: { repositoryId: { type: "string" } },
                                required: ["repositoryId"],
                                additionalProperties: false,
                            },
                        },
                    },
                }],
                webhooks: [{
                    id: WEBHOOK_LOCAL_ID,
                    title: "Repository webhook",
                    verifier: { kind: "github_hmac_sha256_v1", routing: "accountEndpoint" },
                    handlerAction: { localId: HANDLER_ACTION_LOCAL_ID },
                }],
            },
        },
        collectionContracts: [],
        uiSlots: [],
    });
}

async function seedAccount(options: Readonly<{ supportsDurablePush?: boolean }> = {}) {
    const release = releaseFacts({ supportsDurablePush: options.supportsDurablePush !== false });
    const account = await db.account.create({
        data: { encryptionMode: "plain" },
        select: { id: true, seq: true },
    });
    await db.machine.create({
        data: {
            id: MACHINE_ID,
            accountId: account.id,
            metadata: "{}",
            installationId: MACHINE_INSTALLATION_ID,
            pluginMaterializationRevision: 1n,
            operationProtocolCapabilities: { pluginWebhookClaim: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId: account.id,
            pluginId: PLUGIN_ID,
            desiredVersion: PLUGIN_VERSION,
            enabled: true,
            writableCollections: [],
        },
    });
    await db.accountPluginRelease.create({
        data: {
            accountId: account.id,
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
            accountId: account.id,
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
            observedAt: new Date("2026-08-20T00:00:00.000Z"),
        },
    });
    return account;
}

async function ensureEndpoint(accountId: string, idempotencyKey: string) {
    return await ensurePluginWebhookEndpointV1({
        accountId,
        input: PluginWebhookEndpointEnsureInputV1Schema.parse({
            webhookContribution: { pluginId: PLUGIN_ID, localId: WEBHOOK_LOCAL_ID },
            targetMaterialization: MATERIALIZATION_REF,
            sourceInstanceId: ROUTING_SOURCE_INSTANCE_ID,
            setup: { kind: "githubAccountEndpointV1", credential: "serverGenerated" },
            idempotencyKey,
        }),
        contribution: RESOLVED_CONTRIBUTION,
        target: RESOLVED_TARGET,
        publicBaseUrl: "https://happier.example",
    });
}

function pushTrigger(params: Readonly<{
    webhookEndpointId: string;
    sourceInstanceId?: string;
    routingSourceInstanceId?: string;
    displayLabel?: string;
}>) {
    return {
        kind: "pluginEvent" as const,
        eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceInstanceId: params.sourceInstanceId ?? "repository-1",
        sourceContractVersion: 1,
        sourceConfig: { repositoryId: params.sourceInstanceId ?? "repository-1" },
        displayLabel: params.displayLabel ?? "repository-1",
        observationTransport: {
            kind: "durablePush" as const,
            webhookEndpointId: params.webhookEndpointId,
            endpointMaterializationRef: MATERIALIZATION_REF,
            webhookRoutingSourceInstanceId:
                params.routingSourceInstanceId ?? ROUTING_SOURCE_INSTANCE_ID,
            setup: { kind: "githubAccountEndpointV1" as const, credential: "serverGenerated" as const },
        },
        filter: null,
        maximumObservationAgeMs: 60_000,
    };
}

describe("Automation durable-push authoring", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-durable-push-",
            initEncrypt: true,
            env: {
                HANDY_MASTER_SECRET: "automation-durable-push-master-secret",
                HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID,
                HAPPIER_PUBLIC_SERVER_URL: "https://happier.example",
            },
        });
    }, 120_000);

    afterAll(async () => await harness.close());

    beforeEach(() => {
        const emit = vi.fn();
        eventRouter.setIo({ to: vi.fn().mockReturnValue({ emit }) } as never);
    });

    afterEach(async () => {
        harness.resetEnv({
            HANDY_MASTER_SECRET: "automation-durable-push-master-secret",
            HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID,
            HAPPIER_PUBLIC_SERVER_URL: "https://happier.example",
        });
        eventRouter.clearIo();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationEventSourceCatalogStatus.deleteMany(),
            () => db.automationEventSourceStatus.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.pluginWebhookEndpointOperation.deleteMany(),
            () => db.pluginWebhookCredential.deleteMany(),
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

    it("persists a durable-push trigger only through the shared correspondence owner", async () => {
        const account = await seedAccount();
        const endpoint = await ensureEndpoint(account.id, "ensure-durable-push-0001");

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Repository webhooks",
                description: null,
                enabled: true,
                pluginEvent: pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }),
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        });

        expect(created).toMatchObject({
            triggerKind: "pluginEvent",
            triggerObservationTransport: "durablePush",
            triggerWebhookEndpointId: endpoint.webhookEndpointId,
            watcherMachineId: null,
            watcherMachineInstallationId: null,
            watcherPluginId: null,
            watcherMaterializationId: null,
        });
        const persisted = await db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: {
                triggerObservationTransport: true,
                triggerWebhookEndpointId: true,
                triggerObservationStartsAt: true,
                watcherMachineId: true,
            },
        });
        expect(persisted.triggerObservationTransport).toBe("durablePush");
        expect(persisted.triggerWebhookEndpointId).toBe(endpoint.webhookEndpointId);
        expect(persisted.triggerObservationStartsAt).toBeInstanceOf(Date);
        expect(persisted.watcherMachineId).toBeNull();

        // The endpoint-routing source instance is retained privately in the
        // sealed definition and never becomes the Event's own source identity.
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding: {
                v: 1,
                automationId: created.id,
                templateVersion: 1,
                triggerKind: "pluginEvent",
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
                    created.triggerSourceSelectorId,
                ),
            },
            envelope: JSON.parse(created.triggerDefinitionEnvelope!),
        });
        expect(opened.kind).toBe("available");
        expect(AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse(
            (opened as Extract<typeof opened, { kind: "available" }>).definition,
        )).toMatchObject({
            sourceInstanceId: "repository-1",
            webhookRoutingSourceInstanceId: ROUTING_SOURCE_INSTANCE_ID,
        });
    });

    it("refuses a durable-push trigger whose endpoint no longer corresponds", async () => {
        const account = await seedAccount();
        const endpoint = await ensureEndpoint(account.id, "ensure-durable-push-0002");

        await expect(createAutomation({
            accountId: account.id,
            input: {
                name: "Wrong routing source",
                description: null,
                enabled: true,
                pluginEvent: pushTrigger({
                    webhookEndpointId: endpoint.webhookEndpointId,
                    routingSourceInstanceId: "github:installation:9999",
                }),
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);

        await db.pluginWebhookEndpoint.updateMany({
            where: { accountId: account.id },
            data: { revokedAt: new Date(), enabled: false },
        });
        await expect(createAutomation({
            accountId: account.id,
            input: {
                name: "Revoked endpoint",
                description: null,
                enabled: true,
                pluginEvent: pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }),
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);

        expect(await db.automation.count()).toBe(0);
    });

    it("attaches a durable-push trigger before the provider has ever delivered", async () => {
        const account = await seedAccount();
        const endpoint = await ensureEndpoint(account.id, "ensure-durable-push-0005");

        // AUTO-19 correspondence is endpoint existence, ownership, route,
        // target and currentness. Provider configuration is a later external
        // step, and the delivery that would prove it cannot arrive before the
        // Automation that receives it exists, so requiring it here would make
        // first-time authoring unreachable.
        await expect(db.pluginWebhookEndpoint.findUnique({
            where: { id: endpoint.webhookEndpointId },
            select: { providerConfirmedAt: true },
        })).resolves.toEqual({ providerConfirmedAt: null });

        await expect(createAutomation({
            accountId: account.id,
            input: {
                name: "Unconfirmed endpoint",
                description: null,
                enabled: true,
                pluginEvent: pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }),
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        })).resolves.toMatchObject({
            triggerObservationTransport: "durablePush",
            triggerWebhookEndpointId: endpoint.webhookEndpointId,
        });
    });

    it("refuses durable push when the current Event declaration does not support it", async () => {
        const account = await seedAccount({ supportsDurablePush: false });
        const endpoint = await ensureEndpoint(account.id, "ensure-durable-push-0003");

        await expect(createAutomation({
            accountId: account.id,
            input: {
                name: "Unsupported transport",
                description: null,
                enabled: true,
                pluginEvent: pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }),
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        expect(await db.automation.count()).toBe(0);
    });

    it("preserves the observation boundary across a cosmetic edit and resets it when eligibility changes", async () => {
        const account = await seedAccount();
        const endpoint = await ensureEndpoint(account.id, "ensure-durable-push-0004");

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Repository webhooks",
                description: null,
                enabled: true,
                pluginEvent: pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }),
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        });
        const firstBoundary = created.triggerObservationStartsAt;
        expect(firstBoundary).toBeInstanceOf(Date);

        const relabelled = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 1,
            input: {
                name: "Repository webhooks",
                description: null,
                enabled: true,
                pluginEvent: pushTrigger({
                    webhookEndpointId: endpoint.webhookEndpointId,
                    displayLabel: "Repository one",
                }),
                executionRecipe: executionRecipe(2),
                assignments: [{ machineId: MACHINE_ID }],
            },
        });
        expect(relabelled?.triggerObservationStartsAt?.getTime())
            .toBe(firstBoundary!.getTime());

        const refiltered = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 2,
            input: {
                name: "Repository webhooks",
                description: null,
                enabled: true,
                pluginEvent: {
                    ...pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }),
                    maximumObservationAgeMs: 120_000,
                },
                executionRecipe: executionRecipe(3),
                assignments: [{ machineId: MACHINE_ID }],
            },
        });
        expect(refiltered?.triggerObservationStartsAt?.getTime())
            .toBeGreaterThan(firstBoundary!.getTime());
    });
});
