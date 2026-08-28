import { randomUUID } from "node:crypto";

import {
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationSourceSelectorIdV1Schema,
    normalizePluginReleaseFactsV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    PluginWebhookEndpointEnsureInputV1Schema,
} from "@happier-dev/protocol";
import { createPluginEventAutomationSetupResultV1JsonSchema } from "@happier-dev/protocol/automations/event-setup-result";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { eventRouter } from "@/app/events/eventRouter";
import { ensurePluginWebhookEndpointV1 } from "@/app/plugins/webhooks/endpointStore";

import {
    createAutomation,
    deleteAutomationTrigger,
    reconcileAutomationDefinition,
    updateAutomation,
    updateAutomationTrigger,
} from "./automationCrudService";
import { AutomationValidationError } from "./automationValidation";

const SERVER_IDENTITY_ID = "srv_automationDurablePush1";
const PLUGIN_ID = "com.acme.push-writer";
const PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const WEBHOOK_LOCAL_ID = "repository-webhook";
const HANDLER_ACTION_LOCAL_ID = "receive-repository-webhook";
const SETUP_ACTION_LOCAL_ID = "setup-repository-source";
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
    return AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: `Push recipe ${templateVersion}` } },
        triggerEvidence: null,
        target: NEW_SESSION_TARGET,
    });
}

function releaseFacts(params: Readonly<{ supportsDurablePush: boolean }>) {
    const { supportsDurablePush } = params;
    const sourceConfigSchema = {
        type: "object",
        properties: { repositoryId: { type: "string" } },
        required: ["repositoryId"],
        additionalProperties: false,
    } as const;
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
                    id: SETUP_ACTION_LOCAL_ID,
                    title: "Set up repository source",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                    execution: { target: "daemon" },
                    inputSchema: sourceConfigSchema,
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema),
                }, {
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
                            sourceConfigSchema,
                            setupActionRef: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
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
        enabled: true,
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

function pullTrigger(params: Readonly<{
    sourceInstanceId?: string;
    displayLabel?: string;
}> = {}) {
    const sourceInstanceId = params.sourceInstanceId ?? "repository-pull-1";
    return {
        kind: "pluginEvent" as const,
        enabled: true,
        eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceInstanceId,
        sourceContractVersion: 1,
        sourceConfig: { repositoryId: sourceInstanceId },
        displayLabel: params.displayLabel ?? sourceInstanceId,
        observationTransport: {
            kind: "checkpointedPull" as const,
            watcherMaterializationRef: MATERIALIZATION_REF,
        },
        filter: null,
        maximumObservationAgeMs: 60_000,
    };
}

function triggerInput<T>(trigger: T) {
    return { triggerId: randomUUID(), trigger };
}

async function expectPluginEventTombstone(params: Readonly<{
    triggerId: string;
    revision: number;
    sourceSelectorId: string;
}>) {
    await expect(db.automationTrigger.findUniqueOrThrow({
        where: { id: params.triggerId },
        select: {
            kind: true,
            enabled: true,
            revision: true,
            deletedAt: true,
            eventPluginId: true,
            eventLocalId: true,
            sourceSelectorId: true,
            sourceContractVersion: true,
            scheduleKind: true,
            scheduleExpr: true,
            everyMs: true,
            timezone: true,
            nextRunAt: true,
            observationTransport: true,
            webhookEndpointId: true,
            observationStartsAt: true,
            watcherMachineId: true,
            watcherMachineInstallationId: true,
            watcherPluginId: true,
            watcherMaterializationId: true,
            definitionEnvelope: true,
            sessionLifecycleEvent: true,
            sourceSessionId: true,
            sourceTurnId: true,
        },
    })).resolves.toEqual({
        kind: "pluginEvent",
        enabled: false,
        revision: params.revision + 1,
        deletedAt: expect.any(Date),
        eventPluginId: PLUGIN_ID,
        eventLocalId: EVENT_LOCAL_ID,
        sourceSelectorId: params.sourceSelectorId,
        sourceContractVersion: 1,
        scheduleKind: null,
        scheduleExpr: null,
        everyMs: null,
        timezone: null,
        nextRunAt: null,
        observationTransport: null,
        webhookEndpointId: null,
        observationStartsAt: null,
        watcherMachineId: null,
        watcherMachineInstallationId: null,
        watcherPluginId: null,
        watcherMaterializationId: null,
        definitionEnvelope: null,
        sessionLifecycleEvent: null,
        sourceSessionId: null,
        sourceTurnId: null,
    });
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
            () => db.automationTrigger.deleteMany(),
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
                triggers: [triggerInput(pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }))],
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        });

        expect(created.triggers).toEqual([expect.objectContaining({
            kind: "pluginEvent",
            eventPluginId: PLUGIN_ID,
            eventLocalId: EVENT_LOCAL_ID,
            observationTransport: "durablePush",
            webhookEndpointId: endpoint.webhookEndpointId,
            watcherMachineId: null,
            watcherMachineInstallationId: null,
            watcherPluginId: null,
            watcherMaterializationId: null,
        })]);
        const createdTrigger = created.triggers[0]!;
        const persisted = await db.automationTrigger.findUniqueOrThrow({
            where: { id: createdTrigger.id },
            select: {
                observationTransport: true,
                webhookEndpointId: true,
                observationStartsAt: true,
                watcherMachineId: true,
            },
        });
        expect(persisted.observationTransport).toBe("durablePush");
        expect(persisted.webhookEndpointId).toBe(endpoint.webhookEndpointId);
        expect(persisted.observationStartsAt).toBeInstanceOf(Date);
        expect(persisted.watcherMachineId).toBeNull();

        // The endpoint-routing source instance is retained privately in the
        // sealed definition and never becomes the Event's own source identity.
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding: {
                v: 1,
                automationId: created.id,
                triggerId: createdTrigger.id,
                triggerRevision: createdTrigger.revision,
                triggerKind: "pluginEvent",
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
                    createdTrigger.sourceSelectorId,
                ),
            },
            envelope: JSON.parse(createdTrigger.definitionEnvelope!),
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
                triggers: [triggerInput(pushTrigger({
                    webhookEndpointId: endpoint.webhookEndpointId,
                    routingSourceInstanceId: "github:installation:9999",
                }))],
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
                triggers: [triggerInput(pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }))],
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
                triggers: [triggerInput(pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }))],
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        })).resolves.toMatchObject({
            triggers: [expect.objectContaining({
                observationTransport: "durablePush",
                webhookEndpointId: endpoint.webhookEndpointId,
            })],
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
                triggers: [triggerInput(pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }))],
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        expect(await db.automation.count()).toBe(0);
    });

    it("soft-deletes checkpointed-pull and durable-push triggers through the one CRUD tombstone", async () => {
        const account = await seedAccount();
        const endpoint = await ensureEndpoint(account.id, "ensure-durable-push-delete-0001");
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Delete Event transports",
                description: null,
                enabled: true,
                triggers: [
                    triggerInput(pullTrigger()),
                    triggerInput(pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId })),
                ],
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        });
        const pull = created.triggers.find((trigger) => (
            trigger.kind === "pluginEvent"
            && trigger.observationTransport === "checkpointedPull"
        ))!;
        const push = created.triggers.find((trigger) => (
            trigger.kind === "pluginEvent"
            && trigger.observationTransport === "durablePush"
        ))!;
        if (pull.kind !== "pluginEvent" || push.kind !== "pluginEvent") {
            throw new Error("Expected checkpointed-pull and durable-push Event triggers");
        }

        await expect(deleteAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: pull.id,
            expectedRevision: pull.revision,
        })).resolves.toMatchObject({
            triggers: [expect.objectContaining({ id: push.id })],
        });
        await expectPluginEventTombstone({
            triggerId: pull.id,
            revision: pull.revision,
            sourceSelectorId: pull.sourceSelectorId,
        });

        await expect(deleteAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: push.id,
            expectedRevision: push.revision,
        })).resolves.toMatchObject({ triggers: [] });
        await expectPluginEventTombstone({
            triggerId: push.id,
            revision: push.revision,
            sourceSelectorId: push.sourceSelectorId,
        });
    });

    it("atomically removes checkpointed-pull and durable-push triggers through plural reconciliation", async () => {
        const account = await seedAccount();
        const endpoint = await ensureEndpoint(account.id, "ensure-durable-push-delete-0002");
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Reconcile Event transports",
                description: "Both rows use the same tombstone arm",
                enabled: true,
                triggers: [
                    triggerInput(pullTrigger({ sourceInstanceId: "repository-pull-2" })),
                    triggerInput(pushTrigger({
                        webhookEndpointId: endpoint.webhookEndpointId,
                        sourceInstanceId: "repository-push-2",
                    })),
                ],
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        });
        expect(created.triggers).toHaveLength(2);

        await expect(reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: created.templateVersion,
                name: created.name,
                description: created.description,
                enabled: created.enabled,
                assignments: created.assignments.map((assignment) => ({
                    machineId: assignment.machineId,
                    enabled: assignment.enabled,
                    priority: assignment.priority,
                })),
                triggers: [],
                removedTriggers: created.triggers.map((trigger) => ({
                    triggerId: trigger.id,
                    expectedRevision: trigger.revision,
                })),
            },
        })).resolves.toMatchObject({ triggers: [] });

        for (const trigger of created.triggers) {
            if (trigger.kind !== "pluginEvent") {
                throw new Error("Expected only plugin Event trigger fixtures");
            }
            await expectPluginEventTombstone({
                triggerId: trigger.id,
                revision: trigger.revision,
                sourceSelectorId: trigger.sourceSelectorId,
            });
        }
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
                triggers: [triggerInput(pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }))],
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: MACHINE_ID }],
            },
        });
        const createdTrigger = created.triggers[0]!;
        const firstBoundary = createdTrigger.observationStartsAt;
        expect(firstBoundary).toBeInstanceOf(Date);

        const renamed = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTemplateVersion: 1,
            input: {
                name: "Renamed repository webhooks",
                executionRecipe: executionRecipe(2),
            },
        });
        expect(renamed?.triggers[0]).toMatchObject({
            id: createdTrigger.id,
            revision: createdTrigger.revision,
        });
        expect(renamed?.triggers[0]?.observationStartsAt?.getTime())
            .toBe(firstBoundary!.getTime());

        const relabelled = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: createdTrigger.id,
            expectedRevision: createdTrigger.revision,
            trigger: pushTrigger({
                webhookEndpointId: endpoint.webhookEndpointId,
                displayLabel: "Repository one",
            }),
        });
        expect(relabelled?.triggers[0]?.observationStartsAt?.getTime())
            .toBe(firstBoundary!.getTime());

        const relabelledTrigger = relabelled!.triggers[0]!;
        const refiltered = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: relabelledTrigger.id,
            expectedRevision: relabelledTrigger.revision,
            trigger: {
                ...pushTrigger({ webhookEndpointId: endpoint.webhookEndpointId }),
                maximumObservationAgeMs: 120_000,
            },
        });
        expect(refiltered?.triggers[0]?.observationStartsAt?.getTime())
            .toBeGreaterThan(firstBoundary!.getTime());
    });
});
