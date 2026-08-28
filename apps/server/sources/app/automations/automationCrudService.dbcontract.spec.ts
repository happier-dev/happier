import { randomUUID } from "node:crypto";

import {
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    normalizePluginReleaseFactsV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
} from "@happier-dev/protocol";
import { createPluginEventAutomationSetupResultV1JsonSchema } from "@happier-dev/protocol/automations/event-setup-result";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import {
    AutomationTriggerMutationConflictError,
    createAutomation,
    deleteAutomation,
    setAutomationEnabled,
    updateAutomation,
    updateAutomationTrigger,
} from "./automationCrudService";
import { toAutomationDefinitionListItemApiDto } from "./automationApiProjection";
import { AutomationStoredContentReadError } from "./automationStoredContentRead";

const EVENT_PLUGIN_ID = "com.happier.event-crud-dbcontract";
const EVENT_PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const SERVER_IDENTITY_ID = "srv_eventCrudDbcontract";
const SETUP_ACTION_LOCAL_ID = "setup-repository-source";

function resolveContractProviderFromEnv(): "postgres" | "mysql" {
    const raw = String(
        process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres",
    ).trim().toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(
        `Unsupported contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql.`,
    );
}

function eventWriterReleaseFacts() {
    const sourceConfigSchema = {
        type: "object",
        additionalProperties: false,
        properties: { repositoryId: { type: "string" } },
        required: ["repositoryId"],
    } as const;
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: EVENT_PLUGIN_ID, version: EVENT_PLUGIN_VERSION },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"b".repeat(64)}`,
            resources: [],
        },
        normalizedManifest: {
            schemaVersion: 2,
            id: EVENT_PLUGIN_ID,
            version: EVENT_PLUGIN_VERSION,
            displayName: "Event CRUD DB contract fixture",
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
                }],
                events: [{
                    id: EVENT_LOCAL_ID,
                    kind: "event",
                    title: "Repository event",
                    payloadSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string" },
                        },
                        required: ["action"],
                    },
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion: 1,
                            supportedObservationTransports: ["checkpointedPull"],
                            sourceConfigSchema,
                            setupActionRef: { pluginId: EVENT_PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
                        },
                    },
                }],
                webhooks: [],
            },
        },
        collectionContracts: [],
        uiSlots: [],
    });
}

type EventWriterAccount = Readonly<{
    id: string;
    seq: number;
    machineId: string;
    machineInstallationId: string;
    materializationId: string;
}>;

function eventExecutionRecipe(params: Readonly<{
    templateVersion: number;
    machineId: string;
}>) {
    return AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion: params.templateVersion,
        template: {
            t: "plain",
            v: { v: 1, prompt: `Event CRUD DB contract ${params.templateVersion}` },
        },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: {
                    serverId: SERVER_IDENTITY_ID,
                    machineId: params.machineId,
                },
                directory: "/tmp/event-crud-dbcontract",
                agentTarget: {
                    kind: "agent",
                    identity: {
                        pluginId: "happier.agent.codex",
                        localId: "codex",
                    },
                },
            },
        },
    });
}

function eventWriterTrigger(
    account: EventWriterAccount,
    sourceInstanceId: string,
    displayLabel = sourceInstanceId,
) {
    return {
        kind: "pluginEvent" as const,
        enabled: true,
        eventRef: { pluginId: EVENT_PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceInstanceId,
        sourceContractVersion: 1,
        sourceConfig: { repositoryId: sourceInstanceId },
        displayLabel,
        observationTransport: {
            kind: "checkpointedPull" as const,
            watcherMaterializationRef: {
                machineId: account.machineId,
                materializationId: account.materializationId,
                pluginId: EVENT_PLUGIN_ID,
            },
        },
        filter: null,
        maximumObservationAgeMs: null,
    };
}

const ownedAccountIds = new Set<string>();

async function seedEventWriterAccount(mode: "plain" | "e2ee" = "plain"): Promise<EventWriterAccount> {
    const suffix = randomUUID();
    const account = await db.account.create({
        data: mode === "plain"
            ? { encryptionMode: "plain" }
            : { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
        select: { id: true, seq: true },
    });
    ownedAccountIds.add(account.id);

    const machineId = `event-crud-dbcontract-machine-${suffix}`;
    const machineInstallationId = `event-crud-dbcontract-installation-${suffix}`;
    const materializationId = `event-crud-dbcontract-materialization-${suffix}`;
    const release = eventWriterReleaseFacts();
    await db.machine.create({
        data: {
            id: machineId,
            accountId: account.id,
            metadata: "{}",
            installationId: machineInstallationId,
            pluginMaterializationRevision: 1n,
        },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId: account.id,
            pluginId: EVENT_PLUGIN_ID,
            desiredVersion: EVENT_PLUGIN_VERSION,
            enabled: true,
            writableCollections: [],
        },
    });
    await db.accountPluginRelease.create({
        data: {
            accountId: account.id,
            pluginId: EVENT_PLUGIN_ID,
            version: EVENT_PLUGIN_VERSION,
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
            machineId,
            materializationId,
            pluginId: EVENT_PLUGIN_ID,
            version: EVENT_PLUGIN_VERSION,
            sourceClass: "registryPackage",
            portableRelease: true,
            archiveDigestSha256: release.archiveDigestSha256,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted",
            observedAt: new Date("2026-08-13T00:00:00.000Z"),
        },
    });
    return { ...account, machineId, machineInstallationId, materializationId };
}

async function readEventCatalogRevision(accountId: string): Promise<bigint | null> {
    return (await db.automationEventCatalogState.findUnique({
        where: { accountId },
        select: { eventSourceDefinitionsRevision: true },
    }))?.eventSourceDefinitionsRevision ?? null;
}

async function cleanupOwnedAccounts(): Promise<void> {
    for (const accountId of ownedAccountIds) {
        const automationIds = (await db.automation.findMany({
            where: { accountId },
            select: { id: true },
        })).map((automation) => automation.id);
        if (automationIds.length > 0) {
            await db.automationRun.deleteMany({ where: { accountId } });
            await db.automationEventSourceStatus.deleteMany({
                where: { automationId: { in: automationIds } },
            });
            await db.automationAssignment.deleteMany({
                where: { automationId: { in: automationIds } },
            });
            await db.automation.deleteMany({ where: { accountId } });
        }
        await db.accountChange.deleteMany({ where: { accountId } });
        await db.automationEventSourceCatalogStatus.deleteMany({ where: { accountId } });
        await db.automationEventCatalogState.deleteMany({ where: { accountId } });
        await db.pluginMachineMaterialization.deleteMany({ where: { accountId } });
        await db.accountPluginIntent.deleteMany({ where: { accountId } });
        await db.accountPluginRelease.deleteMany({ where: { accountId } });
        await db.machine.deleteMany({ where: { accountId } });
        await db.account.deleteMany({ where: { id: accountId } });
    }
    ownedAccountIds.clear();
}

describe("Automation Event CRUD database contract", () => {
    const provider = resolveContractProviderFromEnv();
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL (required for Automation Event CRUD database contracts).");
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterEach(async () => {
        await cleanupOwnedAccounts();
    });

    afterAll(async () => {
        if (dbConnected) await db.$disconnect();
    });

    it("keeps one plain Event definition's lifecycle, CAS, selector identity, and catalog cursor atomic", async () => {
        const account = await seedEventWriterAccount();
        const firstSource = `repository-first-${randomUUID()}`;
        const privateDisplayLabel = "Private first repository";
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Repository updates",
                enabled: true,
                triggers: [eventWriterTrigger(account, firstSource, privateDisplayLabel)],
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: account.machineId,
                }),
            },
        });
        const createdTrigger = created.triggers[0]!;
        const createdTriggerId = AutomationTriggerIdSchema.parse(createdTrigger.id);
        const firstSelector = AutomationSourceSelectorIdV1Schema.parse(createdTrigger.sourceSelectorId);
        expect(await readEventCatalogRevision(account.id)).toBe(1n);

        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding: {
                v: 1,
                automationId: created.id,
                triggerId: createdTriggerId,
                triggerRevision: createdTrigger.revision,
                triggerKind: "pluginEvent",
                eventRef: { pluginId: EVENT_PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: firstSelector,
            },
            envelope: JSON.parse(createdTrigger.definitionEnvelope ?? "null"),
        });
        expect(opened).toMatchObject({
            kind: "available",
            definition: {
                sourceInstanceId: firstSource,
                displayLabel: privateDisplayLabel,
                sourceConfig: { repositoryId: firstSource },
            },
        });
        const listItem = toAutomationDefinitionListItemApiDto(created);
        expect(listItem.triggers[0]).not.toHaveProperty("definitionEnvelope");
        expect(JSON.stringify(listItem)).not.toContain(privateDisplayLabel);

        const recipeEdited = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTemplateVersion: 1,
            input: {
                name: "Renamed repository updates",
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 2,
                    machineId: account.machineId,
                }),
            },
        });
        expect(recipeEdited).toEqual(expect.objectContaining({ templateVersion: 2 }));
        expect(recipeEdited?.triggers[0]).toEqual(expect.objectContaining({
            id: createdTrigger.id,
            revision: createdTrigger.revision,
            sourceSelectorId: firstSelector,
        }));
        expect(await readEventCatalogRevision(account.id)).toBe(1n);

        const sameSource = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: createdTrigger.id,
            expectedRevision: createdTrigger.revision,
            trigger: eventWriterTrigger(account, firstSource, "Private renamed repository"),
        });
        const sameSourceTrigger = sameSource?.triggers[0]!;
        expect(sameSourceTrigger).toEqual(expect.objectContaining({
            id: createdTrigger.id,
            revision: createdTrigger.revision + 1,
            sourceSelectorId: firstSelector,
        }));
        expect(await readEventCatalogRevision(account.id)).toBe(2n);

        const secondSource = `repository-second-${randomUUID()}`;
        const changedSource = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: createdTrigger.id,
            expectedRevision: sameSourceTrigger.revision,
            trigger: eventWriterTrigger(account, secondSource),
        });
        const changedTrigger = changedSource?.triggers[0]!;
        expect(changedTrigger).toEqual(expect.objectContaining({
            id: createdTrigger.id,
            revision: createdTrigger.revision + 2,
            eventPluginId: EVENT_PLUGIN_ID,
            eventLocalId: EVENT_LOCAL_ID,
        }));
        expect(changedTrigger.sourceSelectorId).not.toBe(firstSelector);
        expect(AutomationSourceSelectorIdV1Schema.safeParse(
            changedTrigger.sourceSelectorId,
        ).success).toBe(true);
        expect(await readEventCatalogRevision(account.id)).toBe(3n);

        await expect(updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: createdTrigger.id,
            expectedRevision: sameSourceTrigger.revision,
            trigger: eventWriterTrigger(account, `repository-stale-${randomUUID()}`),
        })).rejects.toBeInstanceOf(AutomationTriggerMutationConflictError);
        expect(await db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: {
                name: true,
                templateVersion: true,
                triggers: {
                    where: { deletedAt: null },
                    select: { sourceSelectorId: true, revision: true },
                },
            },
        })).toEqual({
            name: "Renamed repository updates",
            templateVersion: 2,
            triggers: [{
                sourceSelectorId: changedTrigger.sourceSelectorId,
                revision: createdTrigger.revision + 2,
            }],
        });
        expect(await readEventCatalogRevision(account.id)).toBe(3n);

        const paused = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        });
        expect(paused).toEqual(expect.objectContaining({ enabled: false }));
        expect(await readEventCatalogRevision(account.id)).toBe(4n);
        const resumed = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
        });
        expect(resumed).toEqual(expect.objectContaining({ enabled: true }));
        expect(await readEventCatalogRevision(account.id)).toBe(5n);
        await expect(deleteAutomation({
            accountId: account.id,
            automationId: created.id,
        })).resolves.toBe(true);
        expect(await readEventCatalogRevision(account.id)).toBe(6n);
        expect(await db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: { deletedAt: true, enabled: true },
        })).toEqual({
            deletedAt: expect.any(Date),
            enabled: false,
        });
        expect(await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).toEqual({ seq: account.seq + 7 });

        const e2ee = await seedEventWriterAccount("e2ee");
        await expect(createAutomation({
            accountId: e2ee.id,
            input: {
                name: "E2EE Event writer is unavailable",
                enabled: true,
                triggers: [eventWriterTrigger(e2ee, `repository-e2ee-${randomUUID()}`)],
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: e2ee.machineId,
                }),
            },
        })).rejects.toBeInstanceOf(AutomationStoredContentReadError);
        expect(await db.automation.count({ where: { accountId: e2ee.id } })).toBe(0);
        expect(await readEventCatalogRevision(e2ee.id)).toBeNull();
    });

    it("keeps multiple Event trigger rows independently identifiable and resumable", async () => {
        const account = await seedEventWriterAccount();
        const leftSource = `capacity-left-${randomUUID()}`;
        const rightSource = `capacity-right-${randomUUID()}`;
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Independent Event sources",
                enabled: true,
                triggers: [
                    { ...eventWriterTrigger(account, leftSource), enabled: false },
                    { ...eventWriterTrigger(account, rightSource), enabled: false },
                ],
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: account.machineId,
                }),
            },
        });
        expect(await readEventCatalogRevision(account.id)).toBe(0n);
        const resumeSeq = (await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).seq;

        const outcomes = await Promise.allSettled([
            updateAutomationTrigger({
                accountId: account.id,
                automationId: created.id,
                triggerId: created.triggers[0]!.id,
                expectedRevision: created.triggers[0]!.revision,
                enabled: true,
            }),
            updateAutomationTrigger({
                accountId: account.id,
                automationId: created.id,
                triggerId: created.triggers[1]!.id,
                expectedRevision: created.triggers[1]!.revision,
                enabled: true,
            }),
        ]);
        const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
        expect(fulfilled).toHaveLength(2);
        expect(await db.automationTrigger.findMany({
            where: {
                automationId: created.id,
                kind: "pluginEvent",
                enabled: true,
                deletedAt: null,
            },
            select: {
                id: true,
                revision: true,
                eventPluginId: true,
                eventLocalId: true,
                sourceSelectorId: true,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })).toEqual(created.triggers.map((trigger) => ({
            id: trigger.id,
            revision: trigger.revision + 1,
            eventPluginId: EVENT_PLUGIN_ID,
            eventLocalId: EVENT_LOCAL_ID,
            sourceSelectorId: trigger.sourceSelectorId,
        })));
        expect(await readEventCatalogRevision(account.id)).toBe(2n);
        expect(await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).toEqual({ seq: resumeSeq + 2 });
    });
});
