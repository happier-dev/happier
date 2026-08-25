import { randomUUID } from "node:crypto";

import {
    AutomationRunExecutionRecipeV1Schema,
    AutomationSourceSelectorIdV1Schema,
    normalizePluginReleaseFactsV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import {
    AutomationTemplateMutationConflictError,
    createAutomation,
    deleteAutomation,
    setAutomationEnabled,
    updateAutomation,
} from "./automationCrudService";
import { toAutomationV3DefinitionListItemApiDto } from "./automationApiProjection";
import { AutomationStoredContentReadError } from "./automationStoredContentRead";

const EVENT_PLUGIN_ID = "com.happier.event-crud-dbcontract";
const EVENT_PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const SERVER_IDENTITY_ID = "srv_eventCrudDbcontract";

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
                actions: [],
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
                            sourceConfigSchema: {
                                type: "object",
                                additionalProperties: false,
                                properties: {
                                    repositoryId: { type: "string" },
                                },
                                required: ["repositoryId"],
                            },
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
    return AutomationRunExecutionRecipeV1Schema.parse({
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
                pluginEvent: eventWriterTrigger(account, firstSource, privateDisplayLabel),
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: account.machineId,
                }),
            },
        });
        const firstSelector = AutomationSourceSelectorIdV1Schema.parse(
            created.triggerSourceSelectorId,
        );
        expect(await readEventCatalogRevision(account.id)).toBe(1n);

        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding: {
                v: 1,
                automationId: created.id,
                templateVersion: 1,
                triggerKind: "pluginEvent",
                eventRef: { pluginId: EVENT_PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: firstSelector,
            },
            envelope: JSON.parse(created.triggerDefinitionEnvelope ?? "null"),
        });
        expect(opened).toMatchObject({
            kind: "available",
            definition: {
                sourceInstanceId: firstSource,
                displayLabel: privateDisplayLabel,
                sourceConfig: { repositoryId: firstSource },
            },
        });
        const listItem = toAutomationV3DefinitionListItemApiDto(created);
        expect(listItem).not.toHaveProperty("triggerDefinitionEnvelope");
        expect(JSON.stringify(listItem)).not.toContain(privateDisplayLabel);

        const sameSource = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 1,
            input: {
                name: "Repository updates",
                enabled: true,
                pluginEvent: eventWriterTrigger(account, firstSource, "Private renamed repository"),
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 2,
                    machineId: account.machineId,
                }),
            },
        });
        expect(sameSource).toEqual(expect.objectContaining({
            templateVersion: 2,
            triggerSourceSelectorId: firstSelector,
        }));
        expect(await readEventCatalogRevision(account.id)).toBe(2n);

        const secondSource = `repository-second-${randomUUID()}`;
        const changedSource = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 2,
            input: {
                name: "Repository updates",
                enabled: true,
                pluginEvent: eventWriterTrigger(account, secondSource),
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 3,
                    machineId: account.machineId,
                }),
            },
        });
        expect(changedSource).toEqual(expect.objectContaining({ templateVersion: 3 }));
        expect(changedSource?.triggerSourceSelectorId).not.toBe(firstSelector);
        expect(AutomationSourceSelectorIdV1Schema.safeParse(
            changedSource?.triggerSourceSelectorId,
        ).success).toBe(true);
        expect(await readEventCatalogRevision(account.id)).toBe(3n);

        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 2,
            input: {
                name: "Stale update",
                enabled: true,
                pluginEvent: eventWriterTrigger(account, `repository-stale-${randomUUID()}`),
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 3,
                    machineId: account.machineId,
                }),
            },
        })).rejects.toBeInstanceOf(AutomationTemplateMutationConflictError);
        expect(await db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: {
                name: true,
                templateVersion: true,
                triggerSourceSelectorId: true,
            },
        })).toEqual({
            name: "Repository updates",
            templateVersion: 3,
            triggerSourceSelectorId: changedSource?.triggerSourceSelectorId,
        });
        expect(await readEventCatalogRevision(account.id)).toBe(3n);

        const paused = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
            expectedTriggerKind: "pluginEvent",
        });
        expect(paused).toEqual(expect.objectContaining({ enabled: false }));
        expect(await readEventCatalogRevision(account.id)).toBe(4n);
        const resumed = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
            expectedTriggerKind: "pluginEvent",
        });
        expect(resumed).toEqual(expect.objectContaining({ enabled: true }));
        expect(await readEventCatalogRevision(account.id)).toBe(5n);
        await expect(deleteAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
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
        })).toEqual({ seq: account.seq + 6 });

        const e2ee = await seedEventWriterAccount("e2ee");
        await expect(createAutomation({
            accountId: e2ee.id,
            input: {
                name: "E2EE Event writer is unavailable",
                enabled: true,
                pluginEvent: eventWriterTrigger(e2ee, `repository-e2ee-${randomUUID()}`),
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: e2ee.machineId,
                }),
            },
        })).rejects.toBeInstanceOf(AutomationStoredContentReadError);
        expect(await db.automation.count({ where: { accountId: e2ee.id } })).toBe(0);
        expect(await readEventCatalogRevision(e2ee.id)).toBeNull();
    });

    it("allows competing Event-source resumes beyond the former aggregate definition ceiling", async () => {
        const account = await seedEventWriterAccount();
        const left = await createAutomation({
            accountId: account.id,
            input: {
                name: "Capacity left",
                enabled: false,
                pluginEvent: eventWriterTrigger(account, `capacity-left-${randomUUID()}`),
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: account.machineId,
                }),
            },
        });
        const right = await createAutomation({
            accountId: account.id,
            input: {
                name: "Capacity right",
                enabled: false,
                pluginEvent: eventWriterTrigger(account, `capacity-right-${randomUUID()}`),
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

        await db.automation.createMany({
            data: Array.from(
                { length: 10_000 },
                (_, index) => ({
                    id: `event-crud-capacity-${index}-${randomUUID()}`,
                    accountId: account.id,
                    name: `Event capacity ${index}`,
                    enabled: true,
                    triggerKind: "pluginEvent" as const,
                    triggerEventPluginId: EVENT_PLUGIN_ID,
                    triggerEventLocalId: EVENT_LOCAL_ID,
                    triggerSourceSelectorId: `event-crud-capacity-selector-${index}`,
                    triggerSourceContractVersion: 1,
                    triggerObservationTransport: "checkpointedPull" as const,
                    triggerDefinitionEnvelope: "retained-capacity-fixture",
                    targetType: "new_session" as const,
                    templateCiphertext: "retained-capacity-fixture",
                }),
            ),
        });

        const outcomes = await Promise.allSettled([
            setAutomationEnabled({
                accountId: account.id,
                automationId: left.id,
                enabled: true,
                expectedTriggerKind: "pluginEvent",
            }),
            setAutomationEnabled({
                accountId: account.id,
                automationId: right.id,
                enabled: true,
                expectedTriggerKind: "pluginEvent",
            }),
        ]);
        const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
        expect(fulfilled).toHaveLength(2);
        expect(await db.automation.count({
            where: {
                accountId: account.id,
                triggerKind: "pluginEvent",
                enabled: true,
                deletedAt: null,
            },
        })).toBe(10_002);
        expect(await readEventCatalogRevision(account.id)).toBe(2n);
        expect(await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).toEqual({ seq: resumeSeq + 2 });
    }, 120_000);
});
