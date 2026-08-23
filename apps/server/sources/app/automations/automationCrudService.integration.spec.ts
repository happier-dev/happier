import {
    AutomationRunExecutionInputV1Schema,
    AutomationRunExecutionRecipeV1Schema,
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationSourceSelectorIdV1Schema,
    buildBackendTargetKey,
    normalizePluginReleaseFactsV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationRunExecutionRecipeV1,
    type AutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { eventRouter } from "@/app/events/eventRouter";

import {
    AutomationAccountEncryptionMigrationConflictError,
    AutomationTemplateMutationConflictError,
    AutomationDisabledError,
    createAutomation,
    deleteAutomation,
    listAutomations,
    matchAutomationAccountEncryptionMigrationPostStateInTx,
    migrateAutomationAccountEncryptionInTx,
    runAutomationNow,
    setAutomationEnabled,
    updateAutomation,
} from "./automationCrudService";
import { AutomationStoredContentReadError } from "./automationStoredContentRead";
import { AutomationValidationError } from "./automationValidation";

function buildTemplateEnvelope(): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: "ciphertext-base64",
    });
}

function buildLegacyTemplateEnvelope(existingSessionId: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: "ciphertext-base64",
        existingSessionId,
    });
}

function legacyTemplateEnvelopeAdmission(existingSessionId: string) {
    return {
        kind: "legacy-encrypted-existing-session-v1" as const,
        existingSessionId,
    };
}

function buildLegacyPlainTemplateEnvelope(existingSessionId: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_plain_v1",
        payload: {
            directory: "/tmp/project",
            existingSessionId,
            sessionEncryptionMode: "plain",
        },
        existingSessionId,
    });
}

function legacyPlainTemplateEnvelopeAdmission(existingSessionId: string) {
    return {
        kind: "legacy-plain-existing-session-v1" as const,
        existingSessionId,
    };
}

const STRICT_MIGRATION_NEW_SESSION_TARGET = {
    kind: "newSession",
    spawn: {
        executionTarget: { serverId: "server", machineId: "machine" },
        directory: "/tmp/automation-migration",
        agentTarget: {
            kind: "agent",
            identity: {
                pluginId: "happier.agent.codex",
                localId: "codex",
            },
        },
    },
} as const;

const EVENT_PLUGIN_ID = "com.acme.event-writer";
const EVENT_PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const EVENT_MACHINE_ID = "event-writer-machine";
const EVENT_MACHINE_INSTALLATION_ID = "event-writer-installation";
const EVENT_MATERIALIZATION_ID = "event-writer-materialization";

function eventExecutionRecipe(templateVersion: number) {
    return AutomationRunExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: `Event recipe ${templateVersion}` } },
        triggerEvidence: null,
        target: STRICT_MIGRATION_NEW_SESSION_TARGET,
    });
}

function eventWriterReleaseFacts(options: Readonly<{ includePayloadSchema?: boolean }> = {}) {
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
            displayName: "Event writer fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: "./dist/index.js" },
            contributes: {
                actions: [],
                events: [{
                    id: EVENT_LOCAL_ID,
                    kind: "event",
                    title: "Repository event",
                    ...(options.includePayloadSchema !== false
                        ? {
                            payloadSchema: {
                                type: "object",
                                additionalProperties: false,
                                properties: {
                                    action: {
                                        type: "string",
                                        enum: ["opened", "closed"],
                                    },
                                    repository: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: {
                                            id: { type: "integer", minimum: 1 },
                                            name: { type: "string", minLength: 1 },
                                        },
                                        required: ["id", "name"],
                                    },
                                },
                                required: ["action", "repository"],
                            },
                        }
                        : {}),
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion: 1,
                            supportedObservationTransports: ["checkpointedPull"],
                            sourceConfigSchema: {
                                type: "object",
                                properties: { repositoryId: { type: "string" } },
                                required: ["repositoryId"],
                                additionalProperties: false,
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

function eventWriterTrigger(sourceInstanceId: string) {
    return {
        kind: "pluginEvent" as const,
        eventRef: { pluginId: EVENT_PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceInstanceId,
        sourceContractVersion: 1,
        sourceConfig: { repositoryId: sourceInstanceId },
        displayLabel: sourceInstanceId,
        observationTransport: {
            kind: "checkpointedPull" as const,
            watcherMaterializationRef: {
                machineId: EVENT_MACHINE_ID,
                materializationId: EVENT_MATERIALIZATION_ID,
                pluginId: EVENT_PLUGIN_ID,
            },
        },
        filter: null,
        maximumObservationAgeMs: 60_000,
    };
}

async function seedEventWriterAccount(
    mode: "plain" | "e2ee" = "plain",
    releaseOptions: Readonly<{ includePayloadSchema?: boolean }> = {},
) {
    const release = eventWriterReleaseFacts(releaseOptions);
    const account = await db.account.create({
        data: mode === "plain"
            ? { encryptionMode: "plain" }
            : { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
        select: { id: true, seq: true },
    });
    await db.machine.create({
        data: {
            id: EVENT_MACHINE_ID,
            accountId: account.id,
            metadata: "{}",
            installationId: EVENT_MACHINE_INSTALLATION_ID,
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
            serverIdentityId: "srv_eventWriterFixture",
            machineId: EVENT_MACHINE_ID,
            materializationId: EVENT_MATERIALIZATION_ID,
            pluginId: EVENT_PLUGIN_ID,
            version: EVENT_PLUGIN_VERSION,
            sourceClass: "registryPackage",
            portableRelease: true,
            archiveDigestSha256: release.archiveDigestSha256,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted",
            observedAt: new Date("2026-08-12T00:00:00.000Z"),
        },
    });
    return account;
}

function buildStrictMigrationRecipe(params: Readonly<{
    templateVersion: number;
    mode: "plain" | "e2ee";
    target?: unknown;
    triggerEvidence?: AutomationRunExecutionRecipeV1["triggerEvidence"];
}>): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: params.templateVersion,
        template: params.mode === "plain"
            ? { t: "plain", v: { v: 1, prompt: "Migrate this definition." } }
            : { t: "encrypted", c: "reencrypted-template" },
        // A Definition has no occurrence-level trigger evidence. It is a Run
        // fact and must remain absent across both migration sides.
        triggerEvidence: params.triggerEvidence ?? null,
        target: params.target ?? STRICT_MIGRATION_NEW_SESSION_TARGET,
    });
    if (serialized.kind !== "available") {
        throw new Error("Failed to construct strict Automation migration recipe");
    }
    return serialized.serialized;
}

const ACCOUNT_MIGRATION_TRIGGER_DEFINITION_MATERIAL = {
    type: "legacy" as const,
    secret: new Uint8Array(32).fill(47),
};

function buildPluginEventMigrationDefinitionEnvelope(params: Readonly<{
    automationId: string;
    templateVersion: number;
    sourceSelectorId: string;
    sourceEnvelope: string;
}>): string {
    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
        params.sourceSelectorId,
    );
    const sourceBinding = {
        v: 1 as const,
        automationId: params.automationId,
        templateVersion: params.templateVersion,
        triggerKind: "pluginEvent" as const,
        eventRef: {
            pluginId: EVENT_PLUGIN_ID,
            localId: EVENT_LOCAL_ID,
        },
        sourceSelectorId,
    };
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "plain",
        binding: sourceBinding,
        envelope: JSON.parse(params.sourceEnvelope),
    });
    if (opened.kind !== "available") {
        throw new Error("Expected a readable plain Event definition fixture");
    }
    const definition = AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse(
        opened.definition,
    );
    return JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "e2ee",
        binding: {
            ...sourceBinding,
            templateVersion: params.templateVersion + 1,
        },
        definition,
        material: ACCOUNT_MIGRATION_TRIGGER_DEFINITION_MATERIAL,
        randomBytes: (length) => new Uint8Array(length).fill(13),
    }));
}

function buildPluginEventMigrationItem(params: Readonly<{
    id: string;
    templateVersion: number;
    triggerSourceSelectorId: string | null;
    triggerDefinitionEnvelope: string | null;
}>) {
    if (
        params.triggerSourceSelectorId === null
        || params.triggerDefinitionEnvelope === null
    ) {
        throw new Error("Expected an Event Definition migration fixture");
    }
    return {
        automationId: params.id,
        expectedTemplateVersion: params.templateVersion,
        templateCiphertext: buildStrictMigrationRecipe({
            templateVersion: params.templateVersion + 1,
            mode: "e2ee",
        }),
        triggerDefinitionEnvelope: buildPluginEventMigrationDefinitionEnvelope({
            automationId: params.id,
            templateVersion: params.templateVersion,
            sourceSelectorId: params.triggerSourceSelectorId,
            sourceEnvelope: params.triggerDefinitionEnvelope,
        }),
    };
}

function buildScheduleMigrationItem(params: Readonly<{
    id: string;
    templateVersion: number;
}>) {
    return {
        automationId: params.id,
        expectedTemplateVersion: params.templateVersion,
        templateCiphertext: buildStrictMigrationRecipe({
            templateVersion: params.templateVersion + 1,
            mode: "e2ee",
        }),
    };
}

function installAutomationSemanticMutationRace(params: Readonly<{
    automationId: string;
    replacementTemplateCiphertext: string;
}>): Readonly<{ restore: () => void }> {
    // Prisma is the system boundary here; the proxy injects a competing semantic
    // write after owner validation and immediately before its conditional write.
    const mutableDb = db as any;
    const originalTransaction = mutableDb.$transaction;

    mutableDb.$transaction = async (
        operation: unknown,
        options: unknown,
    ) => {
        if (typeof operation !== "function") {
            return await originalTransaction.call(
                mutableDb,
                operation,
                options,
            );
        }
        return await originalTransaction.call(
            mutableDb,
            async (tx: any) => {
                const delegate = tx.automation;
                const originalUpdate = delegate.update.bind(delegate);
                const originalUpdateMany =
                    delegate.updateMany.bind(delegate);
                let injected = false;
                const wrappedDelegate = new Proxy(delegate, {
                    get(target, property, receiver) {
                        if (
                            property !== "update"
                            && property !== "updateMany"
                        ) {
                            return Reflect.get(
                                target,
                                property,
                                receiver,
                            );
                        }
                        return async (args: any) => {
                            if (
                                !injected
                                && args.data?.targetType
                                    !== undefined
                            ) {
                                injected = true;
                                await originalUpdate({
                                    where: {
                                        id: params.automationId,
                                    },
                                    data: {
                                        templateCiphertext:
                                            params
                                                .replacementTemplateCiphertext,
                                        templateVersion: {
                                            increment: 1,
                                        },
                                    },
                                });
                            }
                            return property === "update"
                                ? await originalUpdate(args)
                                : await originalUpdateMany(args);
                        };
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === "automation") {
                            return wrappedDelegate;
                        }
                        return Reflect.get(
                            target,
                            property,
                            receiver,
                        );
                    },
                });
                return await operation(wrappedTx);
            },
            options,
        );
    };

    return {
        restore: () => {
            mutableDb.$transaction = originalTransaction;
        },
    };
}

function installAutomationV2AssignmentReplacementRace(params: Readonly<{
    automationId: string;
    replacementTemplateCiphertext: string;
}>): Readonly<{ restore: () => void; wasInjected: () => boolean }> {
    // Prisma is the system boundary here. Once the initial V2 read has
    // returned its legacy snapshot, inject a current strict Definition before
    // the caller can replace assignments.
    const mutableDb = db as any;
    const originalTransaction = mutableDb.$transaction;
    let injected = false;

    mutableDb.$transaction = async (
        operation: unknown,
        options: unknown,
    ) => {
        if (typeof operation !== "function") {
            return await originalTransaction.call(
                mutableDb,
                operation,
                options,
            );
        }
        return await originalTransaction.call(
            mutableDb,
            async (tx: any) => {
                const delegate = tx.automation;
                const originalFindFirst = delegate.findFirst.bind(delegate);
                const originalUpdate = delegate.update.bind(delegate);
                const wrappedDelegate = new Proxy(delegate, {
                    get(target, property, receiver) {
                        if (property !== "findFirst") {
                            return Reflect.get(
                                target,
                                property,
                                receiver,
                            );
                        }
                        return async (args: any) => {
                            const row = await originalFindFirst(args);
                            if (
                                !injected
                                && args.where?.id === params.automationId
                            ) {
                                injected = true;
                                await originalUpdate({
                                    where: { id: params.automationId },
                                    data: {
                                        targetType: "new_session",
                                        templateCiphertext:
                                            params.replacementTemplateCiphertext,
                                        templateVersion: { increment: 1 },
                                    },
                                });
                            }
                            return row;
                        };
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === "automation") {
                            return wrappedDelegate;
                        }
                        return Reflect.get(
                            target,
                            property,
                            receiver,
                        );
                    },
                });
                return await operation(wrappedTx);
            },
            options,
        );
    };

    return {
        restore: () => {
            mutableDb.$transaction = originalTransaction;
        },
        wasInjected: () => injected,
    };
}

describe("automationCrudService (integration)", () => {
    let harness: LightSqliteHarness;
    let ioTo: ReturnType<typeof vi.fn>;
    let emit: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-automation-crud-service-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        ioTo = vi.fn();
        emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);
    });

    afterEach(async () => {
        harness.resetEnv();
        eventRouter.clearIo();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationEventSourceCatalogStatus.deleteMany(),
            () => db.automationEventSourceStatus.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("writes, revises, pauses, resumes, and deletes one plain Event definition atomically", async () => {
        const account = await seedEventWriterAccount();
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Repository updates",
                description: null,
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-1"),
                executionRecipe: eventExecutionRecipe(1),
                assignments: [{ machineId: EVENT_MACHINE_ID }],
            },
        });

        expect(created).toMatchObject({
            triggerKind: "pluginEvent",
            scheduleKind: null,
            triggerEventPluginId: EVENT_PLUGIN_ID,
            triggerEventLocalId: EVENT_LOCAL_ID,
            triggerSourceContractVersion: 1,
            triggerObservationTransport: "checkpointedPull",
            watcherMachineId: EVENT_MACHINE_ID,
            watcherMachineInstallationId: EVENT_MACHINE_INSTALLATION_ID,
        });
        const firstSelector = AutomationSourceSelectorIdV1Schema.parse(
            created.triggerSourceSelectorId,
        );
        expect(await db.automationRun.count({
            where: { automationId: created.id },
        })).toBe(0);
        expect(await db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).toEqual({ eventSourceDefinitionsRevision: 1n });
        expect((await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).seq).toBe(account.seq + 1);

        const binding = {
            v: 1 as const,
            automationId: created.id,
            templateVersion: 1,
            triggerKind: "pluginEvent" as const,
            eventRef: { pluginId: EVENT_PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: firstSelector,
        };
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding,
            envelope: JSON.parse(created.triggerDefinitionEnvelope!),
        });
        expect(opened).toMatchObject({
            kind: "available",
            definition: {
                sourceInstanceId: "repository-1",
                displayLabel: "repository-1",
                sourceConfig: { repositoryId: "repository-1" },
            },
        });

        const sameSource = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 1,
            input: {
                name: "Repository updates",
                description: null,
                enabled: true,
                pluginEvent: {
                    ...eventWriterTrigger("repository-1"),
                    displayLabel: "Repository one",
                },
                executionRecipe: eventExecutionRecipe(2),
                assignments: [{ machineId: EVENT_MACHINE_ID }],
            },
        });
        expect(sameSource?.triggerSourceSelectorId).toBe(firstSelector);
        expect(sameSource?.templateVersion).toBe(2);

        const changedSource = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 2,
            input: {
                name: "Repository updates",
                description: null,
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-2"),
                executionRecipe: eventExecutionRecipe(3),
                assignments: [{ machineId: EVENT_MACHINE_ID }],
            },
        });
        expect(changedSource?.triggerSourceSelectorId).not.toBe(firstSelector);
        expect(AutomationSourceSelectorIdV1Schema.safeParse(
            changedSource?.triggerSourceSelectorId,
        ).success).toBe(true);

        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 2,
            input: {
                name: "Stale",
                description: null,
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-stale"),
                executionRecipe: eventExecutionRecipe(3),
            },
        })).rejects.toBeInstanceOf(AutomationTemplateMutationConflictError);

        await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        });
        await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
        });
        await deleteAutomation({
            accountId: account.id,
            automationId: created.id,
        });

        expect(await db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).toEqual({ eventSourceDefinitionsRevision: 6n });
        expect((await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).seq).toBe(account.seq + 6);
    });

    it("removes the Event source status a selector change made unreachable and keeps every other definition's", async () => {
        const account = await seedEventWriterAccount();
        const changing = await createAutomation({
            accountId: account.id,
            input: {
                name: "Changing source",
                description: null,
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-1"),
                executionRecipe: eventExecutionRecipe(1),
                assignments: [{ machineId: EVENT_MACHINE_ID }],
            },
        });
        const untouched = await createAutomation({
            accountId: account.id,
            input: {
                name: "Untouched source",
                description: null,
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-9"),
                executionRecipe: eventExecutionRecipe(1),
                assignments: [{ machineId: EVENT_MACHINE_ID }],
            },
        });
        const supersededSelector = changing!.triggerSourceSelectorId!;
        for (const automation of [changing!, untouched!]) {
            await db.automationEventSourceStatus.create({
                data: {
                    automationId: automation.id,
                    eventPluginId: EVENT_PLUGIN_ID,
                    eventLocalId: EVENT_LOCAL_ID,
                    sourceSelectorId: automation.triggerSourceSelectorId!,
                    templateVersion: automation.templateVersion,
                    reporterMachineId: EVENT_MACHINE_ID,
                    reporterMachineInstallationId: EVENT_MACHINE_INSTALLATION_ID,
                    reporterMaterializationId: EVENT_MATERIALIZATION_ID,
                    state: "observing",
                },
            });
        }

        const changed = await updateAutomation({
            accountId: account.id,
            automationId: changing!.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: changing!.templateVersion,
            input: {
                name: "Changing source",
                description: null,
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-2"),
                executionRecipe: eventExecutionRecipe(2),
                assignments: [{ machineId: EVENT_MACHINE_ID }],
            },
        });
        expect(changed?.triggerSourceSelectorId).not.toBe(supersededSelector);

        // The projection only ever reads the current selector, so the previous
        // row is unreachable and must not accumulate. Every other definition's
        // status is untouched.
        await expect(db.automationEventSourceStatus.findMany({
            orderBy: { automationId: "asc" },
            select: { automationId: true, sourceSelectorId: true },
        })).resolves.toEqual([{
            automationId: untouched!.id,
            sourceSelectorId: untouched!.triggerSourceSelectorId,
        }]);
    });

    it("does not change the Event source catalog revision for an assignment-only V3 update", async () => {
        const account = await seedEventWriterAccount();
        const event = await createAutomation({
            accountId: account.id,
            input: {
                name: "Assigned repository updates",
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-assignment-update"),
                executionRecipe: eventExecutionRecipe(1),
                assignments: [{ machineId: EVENT_MACHINE_ID, enabled: true, priority: 0 }],
            },
        });

        // This is the exact assignment-only input accepted by the V3
        // assignments route: no definition rewrite and no template version.
        const eventAssignmentUpdate = await updateAutomation({
            accountId: account.id,
            automationId: event.id,
            input: { assignments: [] },
        });
        expect(eventAssignmentUpdate?.assignments).toEqual([]);
        expect(await db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).toEqual({ eventSourceDefinitionsRevision: 1n });

        const schedule = await createAutomation({
            accountId: account.id,
            input: {
                name: "Assigned schedule",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                executionRecipe: eventExecutionRecipe(1),
                assignments: [{ machineId: EVENT_MACHINE_ID, enabled: true, priority: 0 }],
            },
        });
        const scheduleAssignmentUpdate = await updateAutomation({
            accountId: account.id,
            automationId: schedule.id,
            input: { assignments: [] },
        });
        expect(scheduleAssignmentUpdate?.assignments).toEqual([]);
        expect(await db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).toEqual({ eventSourceDefinitionsRevision: 1n });
    });

    it("refuses invalid, E2EE, and over-capacity Event writes without partial mutation", async () => {
        const plain = await seedEventWriterAccount();
        await expect(createAutomation({
            accountId: plain.id,
            input: {
                name: "Invalid source",
                enabled: true,
                pluginEvent: {
                    ...eventWriterTrigger("repository-invalid"),
                    sourceConfig: { undeclared: true },
                },
                executionRecipe: eventExecutionRecipe(1),
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        expect(await db.automation.count({ where: { accountId: plain.id } })).toBe(0);
        expect(await db.automationEventCatalogState.count({
            where: { accountId: plain.id },
        })).toBe(0);
        expect((await db.account.findUniqueOrThrow({
            where: { id: plain.id },
            select: { seq: true },
        })).seq).toBe(plain.seq);

        await expect(createAutomation({
            accountId: plain.id,
            input: {
                name: "Assignment rollback",
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-rollback"),
                executionRecipe: eventExecutionRecipe(1),
                assignments: [{ machineId: "missing-event-writer-machine" }],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        expect(await db.automation.count({ where: { accountId: plain.id } })).toBe(0);
        expect(await db.automationEventCatalogState.count({
            where: { accountId: plain.id },
        })).toBe(0);
        expect((await db.account.findUniqueOrThrow({
            where: { id: plain.id },
            select: { seq: true },
        })).seq).toBe(plain.seq);

        // This retained row isolates the enable transition from plugin-release
        // currentness; create-at-capacity below still exercises the full writer.
        const disabledAtCapacity = await db.automation.create({
            data: {
                id: "event-disabled-capacity",
                accountId: plain.id,
                name: "Disabled capacity candidate",
                enabled: false,
                triggerKind: "pluginEvent",
                triggerEventPluginId: EVENT_PLUGIN_ID,
                triggerEventLocalId: EVENT_LOCAL_ID,
                triggerSourceSelectorId: "event-disabled-capacity-selector",
                triggerSourceContractVersion: 1,
                triggerObservationTransport: "checkpointedPull",
                triggerDefinitionEnvelope: "retained-capacity-fixture",
                targetType: "new_session",
                templateCiphertext: "retained-capacity-fixture",
            },
        });
        const capacityBaseline = {
            accountSeq: (await db.account.findUniqueOrThrow({
                where: { id: plain.id },
                select: { seq: true },
            })).seq,
            catalogState: await db.automationEventCatalogState.findUnique({
                where: { accountId: plain.id },
                select: { eventSourceDefinitionsRevision: true },
            }),
        };

        await db.automation.createMany({
            data: Array.from({ length: 10_000 }, (_, index) => ({
                id: `event-capacity-${index}`,
                accountId: plain.id,
                name: `Event capacity ${index}`,
                enabled: true,
                triggerKind: "pluginEvent" as const,
                triggerEventPluginId: EVENT_PLUGIN_ID,
                triggerEventLocalId: EVENT_LOCAL_ID,
                triggerSourceSelectorId: `event-capacity-selector-${index}`,
                triggerSourceContractVersion: 1,
                triggerObservationTransport: "checkpointedPull" as const,
                triggerDefinitionEnvelope: "retained-capacity-fixture",
                targetType: "new_session" as const,
                templateCiphertext: "retained-capacity-fixture",
            })),
        });
        const createConflict = await createAutomation({
            accountId: plain.id,
            input: {
                name: "Over capacity",
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-over-capacity"),
                executionRecipe: eventExecutionRecipe(1),
            },
        }).catch((error: unknown) => error);
        expect(createConflict).toMatchObject({
            name: "AutomationEventDefinitionCapacityConflictError",
            enabledCount: 10_000,
        });

        const resumeConflict = await setAutomationEnabled({
            accountId: plain.id,
            automationId: disabledAtCapacity.id,
            enabled: true,
        }).catch((error: unknown) => error);
        expect(resumeConflict).toMatchObject({
            name: "AutomationEventDefinitionCapacityConflictError",
            enabledCount: 10_000,
        });
        expect(await db.automation.count({ where: { accountId: plain.id } })).toBe(10_001);
        expect(await db.automation.findUniqueOrThrow({
            where: { id: disabledAtCapacity.id },
            select: { enabled: true },
        })).toEqual({ enabled: false });
        expect((await db.account.findUniqueOrThrow({
            where: { id: plain.id },
            select: { seq: true },
        })).seq).toBe(capacityBaseline.accountSeq);
        expect(await db.automationEventCatalogState.findUnique({
            where: { accountId: plain.id },
            select: { eventSourceDefinitionsRevision: true },
        })).toEqual(capacityBaseline.catalogState);

        await db.automation.delete({ where: { id: "event-capacity-9999" } });
        await setAutomationEnabled({
            accountId: plain.id,
            automationId: disabledAtCapacity.id,
            enabled: true,
        });
        expect(await db.automation.count({ where: { accountId: plain.id } })).toBe(10_000);

        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
        const e2ee = await seedEventWriterAccount("e2ee");
        await expect(createAutomation({
            accountId: e2ee.id,
            input: {
                name: "Encrypted unavailable",
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-e2ee"),
                executionRecipe: eventExecutionRecipe(1),
            },
        })).rejects.toBeInstanceOf(AutomationStoredContentReadError);
        expect(await db.automation.count({ where: { accountId: e2ee.id } })).toBe(0);
        expect(await db.automationEventCatalogState.count({
            where: { accountId: e2ee.id },
        })).toBe(0);
    });

    it("rejects undeclared or incompatible Event filters before create or patch mutation", async () => {
        const account = await seedEventWriterAccount();

        const invalidCreate = await createAutomation({
            accountId: account.id,
            input: {
                name: "Unknown filter path",
                enabled: true,
                pluginEvent: {
                    ...eventWriterTrigger("repository-filter-create"),
                    filter: {
                        v: 1,
                        all: [{
                            op: "eq",
                            field: "/repository/unknown",
                            value: "missing",
                        }],
                    },
                },
                executionRecipe: eventExecutionRecipe(1),
            },
        }).catch((error: unknown) => error);

        expect(invalidCreate).toMatchObject({
            name: "AutomationEventFilterValidationError",
            code: "field_not_declared",
        });
        expect(await db.automation.count({ where: { accountId: account.id } })).toBe(0);

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Valid filter",
                enabled: true,
                pluginEvent: {
                    ...eventWriterTrigger("repository-filter-patch"),
                    filter: {
                        v: 1,
                        all: [{ op: "in", field: "/action", values: ["opened", "closed"] }],
                    },
                },
                executionRecipe: eventExecutionRecipe(1),
            },
        });

        const invalidPatch = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 1,
            input: {
                name: "Incompatible filter value",
                enabled: true,
                pluginEvent: {
                    ...eventWriterTrigger("repository-filter-patch"),
                    filter: {
                        v: 1,
                        all: [{ op: "eq", field: "/repository/id", value: "not-an-integer" }],
                    },
                },
                executionRecipe: eventExecutionRecipe(2),
            },
        }).catch((error: unknown) => error);

        expect(invalidPatch).toMatchObject({
            name: "AutomationEventFilterValidationError",
            code: "value_incompatible",
        });
        expect(await db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: { templateVersion: true, name: true },
        })).toEqual({ templateVersion: 1, name: "Valid filter" });
    });

    it("rejects an Event declaration without a payload schema before mutation", async () => {
        const account = await seedEventWriterAccount("plain", { includePayloadSchema: false });

        const result = await createAutomation({
            accountId: account.id,
            input: {
                name: "Schema-less Event",
                enabled: true,
                pluginEvent: eventWriterTrigger("repository-without-payload-schema"),
                executionRecipe: eventExecutionRecipe(1),
            },
        }).catch((error: unknown) => error);

        expect(result).toMatchObject({
            name: "AutomationEventFilterValidationError",
            code: "payload_schema_missing",
        });
        expect(await db.automation.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("stores cron schedules with scheduleExpr and enqueues the first run", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Cron session",
                description: null,
                enabled: true,
                schedule: { kind: "cron", scheduleExpr: "*/5 * * * *", timezone: "UTC" },
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        expect(created.scheduleKind).toBe("cron");
        expect(created.scheduleExpr).toBe("*/5 * * * *");
        expect(created.everyMs).toBeNull();

        const queuedRuns = await db.automationRun.count({
            where: { automationId: created.id, state: "queued" },
        });
        expect(queuedRuns).toBe(1);
    });

    it("disabling terminalizes all queued Run origins without erasing durable history or resurrecting them on re-enable", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Hourly session",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        const scheduledRun = await db.automationRun.findFirst({
            where: {
                automationId: created.id,
                state: "queued",
                originKind: "scheduled",
            },
            select: { id: true },
        });
        expect(scheduledRun).not.toBeNull();

        const manualRun = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
        });
        expect(manualRun).toEqual(expect.objectContaining({
            originKind: "manual",
            state: "queued",
        }));

        const now = new Date();
        const pluginEventRunId = "pause-plugin-event-run";
        const conversationRunId = "pause-conversation-run";
        await db.automationRun.createMany({
            data: [
                {
                    id: pluginEventRunId,
                    automationId: created.id,
                    accountId: account.id,
                    state: "queued",
                    originKind: "pluginEvent",
                    originOccurredAt: now,
                    occurrenceKey: "pause-plugin-event-occurrence",
                    originSourceSelectorId: "pause-plugin-event-selector",
                    triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    scheduledAt: now,
                    dueAt: now,
                },
                {
                    id: conversationRunId,
                    automationId: created.id,
                    accountId: account.id,
                    state: "queued",
                    originKind: "conversation",
                    originOccurredAt: now,
                    occurrenceKey: "pause-conversation-occurrence",
                    originSourceSelectorId: null,
                    triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    scheduledAt: now,
                    dueAt: now,
                },
            ],
        });

        const paused = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        });
        expect(paused).toEqual(expect.objectContaining({
            enabled: false,
            assignments: [expect.objectContaining({
                machineId: "machine-1",
                enabled: true,
                priority: 0,
            })],
        }));

        const runsAfterPause = await db.automationRun.findMany({
            where: {
                automationId: created.id,
            },
            select: { id: true, originKind: true, state: true, finishedAt: true },
        });
        expect(runsAfterPause).toHaveLength(4);
        expect(runsAfterPause).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: scheduledRun!.id,
                originKind: "scheduled",
                state: "cancelled",
                finishedAt: expect.any(Date),
            }),
            expect.objectContaining({
                id: pluginEventRunId,
                originKind: "pluginEvent",
                state: "cancelled",
                finishedAt: expect.any(Date),
            }),
            expect.objectContaining({
                id: conversationRunId,
                originKind: "conversation",
                state: "cancelled",
                finishedAt: expect.any(Date),
            }),
            expect.objectContaining({
                id: manualRun!.id,
                originKind: "manual",
                state: "cancelled",
                finishedAt: expect.any(Date),
            }),
        ]));
        await expect(db.automationRunEvent.count({
            where: {
                runId: { in: [scheduledRun!.id, manualRun!.id, pluginEventRunId, conversationRunId] },
                type: "run_cancelled",
            },
        })).resolves.toBe(4);

        const reenabled = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
        });
        expect(reenabled).toEqual(expect.objectContaining({
            enabled: true,
            assignments: [expect.objectContaining({
                machineId: "machine-1",
                enabled: true,
                priority: 0,
            })],
        }));

        const runsAfterResume = await db.automationRun.findMany({
            where: {
                automationId: created.id,
            },
            select: { id: true, originKind: true, state: true },
        });
        expect(runsAfterResume).toEqual(expect.arrayContaining([
            { id: scheduledRun!.id, originKind: "scheduled", state: "cancelled" },
            { id: pluginEventRunId, originKind: "pluginEvent", state: "cancelled" },
            { id: conversationRunId, originKind: "conversation", state: "cancelled" },
            { id: manualRun!.id, originKind: "manual", state: "cancelled" },
        ]));
        await expect(db.automationRun.count({
            where: {
                automationId: created.id,
                originKind: { in: ["pluginEvent", "conversation"] },
                state: "queued",
            },
        })).resolves.toBe(0);
        await expect(db.automationRun.count({
            where: {
                automationId: created.id,
                originKind: "scheduled",
                state: "queued",
            },
        })).resolves.toBe(1);
    });

    it("soft-deletes an Automation with retained Runs without cascading its durable history", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-retained-history",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Retained history",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "retain run history" },
                }),
                assignments: [{ machineId: "machine-retained-history" }],
            },
        });
        const runBeforeDelete = await db.automationRun.findFirst({
            where: { automationId: created.id },
            select: { id: true },
        });
        expect(runBeforeDelete).not.toBeNull();

        await expect(deleteAutomation({
            accountId: account.id,
            automationId: created.id,
        })).resolves.toBe(true);

        expect(await db.automation.findUnique({
            where: { id: created.id },
            select: { enabled: true, deletedAt: true },
        })).toMatchObject({ enabled: false, deletedAt: expect.any(Date) });
        expect(await db.automationRun.findUnique({
            where: { id: runBeforeDelete!.id },
            select: { automationId: true },
        })).toEqual({ automationId: created.id });
        await expect(listAutomations({ accountId: account.id })).resolves.toEqual([]);
    });

    it("run-now adds an immediate queued run without deleting the scheduled queue", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Immediate run",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 300_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        const beforeRunNow = await db.automationRun.findMany({
            where: {
                automationId: created.id,
                state: "queued",
            },
            select: { id: true, dueAt: true },
            orderBy: [{ dueAt: "asc" }],
        });
        expect(beforeRunNow).toHaveLength(1);

        const immediate = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
        });
        expect(immediate).not.toBeNull();

        // User-scoped update (UI) + machine-only wakeup (daemon).
        const targets = ioTo.mock.calls.map(([arg]) => arg);
        expect(targets).toContain(`user-scoped:${account.id}`);
        expect(targets).toContain(`machine:machine-1:${account.id}`);

        const afterRunNow = await db.automationRun.findMany({
            where: {
                automationId: created.id,
                state: "queued",
            },
            select: { id: true, dueAt: true },
            orderBy: [{ dueAt: "asc" }],
        });
        expect(afterRunNow).toHaveLength(2);
    });

    it("rejoins keyed manual occurrences and rejects net-new work while paused", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "On demand",
                description: null,
                enabled: true,
                manual: true,
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        expect(created).toEqual(expect.objectContaining({
            triggerKind: "manual",
            scheduleKind: null,
            nextRunAt: null,
        }));
        await expect(db.automationRun.count({
            where: { automationId: created.id },
        })).resolves.toBe(0);

        const first = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-42",
        });
        const replay = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-42",
        });
        const distinct = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-43",
        });
        expect(replay?.id).toBe(first?.id);
        expect(distinct?.id).not.toBe(first?.id);
        await expect(db.automationRun.count({
            where: { automationId: created.id },
        })).resolves.toBe(2);

        await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        });
        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-42",
        })).resolves.toEqual(expect.objectContaining({ id: first!.id, state: "cancelled" }));
        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-44",
        })).rejects.toBeInstanceOf(AutomationDisabledError);
    });

    it("rejoins a keyed manual Run created by the remote-dev predecessor", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Preview manual run",
                description: null,
                enabled: true,
                manual: true,
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        const now = new Date();
        const predecessorRun = await db.automationRun.create({
            data: {
                automationId: created.id,
                accountId: account.id,
                state: "queued",
                originKind: "manual",
                legacyManualIdempotencyKey: "preview-build-41",
                scheduledAt: now,
                dueAt: now,
            },
            select: { id: true },
        });

        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "preview-build-41",
        })).resolves.toEqual(expect.objectContaining({ id: predecessorRun.id }));
        await expect(db.automationRun.count({
            where: { automationId: created.id },
        })).resolves.toBe(1);
    });

    it("keeps a queued remote-dev V2 Run snapshot immutable after its Definition template changes", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-v2-snapshot",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const originalTemplateCiphertext = buildTemplateEnvelope();
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Immutable V2 queue snapshot",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: originalTemplateCiphertext,
                assignments: [{ machineId: "machine-v2-snapshot" }],
            },
        });
        const queued = await db.automationRun.findFirstOrThrow({
            where: {
                automationId: created.id,
                originKind: "scheduled",
                state: "queued",
            },
            select: { id: true, executionInputEnvelope: true },
        });
        expect(queued.executionInputEnvelope).not.toBeNull();

        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: {
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_encrypted_v1",
                    payloadCiphertext: "changed-ciphertext-base64",
                }),
            },
        })).resolves.toEqual(expect.objectContaining({
            templateVersion: created.templateVersion + 1,
        }));

        const after = await db.automationRun.findUniqueOrThrow({
            where: { id: queued.id },
            select: { executionInputEnvelope: true },
        });
        expect(after.executionInputEnvelope).toBe(queued.executionInputEnvelope);
        expect(AutomationRunExecutionInputV1Schema.parse(JSON.parse(
            after.executionInputEnvelope!,
        ))).toEqual(expect.objectContaining({
            templateVersion: created.templateVersion,
            templateCiphertext: originalTemplateCiphertext,
        }));
    });

    it("fails closed across CRUD Run writers when E2EE Account currentness is inconsistent", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-inconsistent-crud-writer",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Inconsistent Account CRUD writer",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 300_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{ machineId: "machine-inconsistent-crud-writer", enabled: true, priority: 0 }],
            },
        });
        await db.account.update({
            where: { id: account.id },
            data: {
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
        });

        const immediate = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
        });
        const updated = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: { name: "must-not-write" },
        });
        const deleted = await deleteAutomation({
            accountId: account.id,
            automationId: created.id,
        });

        expect(immediate).toBeNull();
        expect(updated).toBeNull();
        expect(deleted).toBe(false);
        await expect(db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: { name: true, deletedAt: true },
        })).resolves.toEqual({
            name: "Inconsistent Account CRUD writer",
            deletedAt: null,
        });
        await expect(db.automationRun.findMany({
            where: { automationId: created.id },
            select: { state: true },
        })).resolves.toEqual([{ state: "queued" }]);
    });

    it("notifies removed machines when assignments change", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.createMany({
            data: [
                {
                    id: "machine-1",
                    accountId: account.id,
                    metadata: "{}",
                },
                {
                    id: "machine-2",
                    accountId: account.id,
                    metadata: "{}",
                },
            ],
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Assignment removal",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [
                    { machineId: "machine-1", enabled: true, priority: 0 },
                    { machineId: "machine-2", enabled: true, priority: 0 },
                ],
            },
        });

        ioTo.mockClear();
        emit.mockClear();

        const updated = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: {
                assignments: [{ machineId: "machine-2", enabled: true, priority: 0 }],
            },
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        });

        expect(updated).not.toBeNull();
        await expect(db.automationAssignment.findMany({
            where: { automationId: created.id },
            select: { machineId: true, enabled: true, priority: true },
        })).resolves.toEqual([{
            machineId: "machine-2",
            enabled: true,
            priority: 0,
        }]);
        expect(ioTo.mock.calls.some(([target]) =>
            Array.isArray(target)
            && target.includes(`machine:machine-1:${account.id}`)
            && target.includes(`user-scoped:${account.id}`),
        )).toBe(true);
        expect(emit).toHaveBeenCalledWith(
            "update",
            expect.objectContaining({
                body: expect.objectContaining({
                    t: "automation-assignment-updated",
                    machineId: "machine-1",
                    automationId: created.id,
                    enabled: false,
                }),
            }),
        );
    });

    it("rolls back a V2 assignment-only update if the Definition becomes strict V3 after its initial load", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.createMany({
            data: [
                {
                    id: "machine-v2-assignment-race-original",
                    accountId: account.id,
                    metadata: "{}",
                },
                {
                    id: "machine-v2-assignment-race-replacement",
                    accountId: account.id,
                    metadata: "{}",
                },
            ],
        });
        const originalTemplateCiphertext = buildTemplateEnvelope();
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "V2 assignment race",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: originalTemplateCiphertext,
                assignments: [{
                    machineId: "machine-v2-assignment-race-original",
                    enabled: true,
                    priority: 0,
                }],
            },
        });
        const strictV3TemplateCiphertext = buildStrictMigrationRecipe({
            templateVersion: created.templateVersion + 1,
            mode: "e2ee",
        });
        const race = installAutomationV2AssignmentReplacementRace({
            automationId: created.id,
            replacementTemplateCiphertext: strictV3TemplateCiphertext,
        });
        try {
            await expect(updateAutomation({
                accountId: account.id,
                automationId: created.id,
                input: {
                    assignments: [{
                        machineId: "machine-v2-assignment-race-replacement",
                        enabled: true,
                        priority: 0,
                    }],
                },
                expectedTriggerKind: "schedule",
                requireV2DefinitionRepresentability: true,
            })).rejects.toBeInstanceOf(AutomationTemplateMutationConflictError);
        } finally {
            race.restore();
        }

        expect(race.wasInjected()).toBe(true);
        await expect(db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: {
                targetType: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        })).resolves.toEqual({
            targetType: "new_session",
            templateCiphertext: originalTemplateCiphertext,
            templateVersion: created.templateVersion,
        });
        await expect(db.automationAssignment.findMany({
            where: { automationId: created.id },
            select: { machineId: true, enabled: true, priority: true },
        })).resolves.toEqual([{
            machineId: "machine-v2-assignment-race-original",
            enabled: true,
            priority: 0,
        }]);

        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: {
                assignments: [{
                    machineId: "machine-v2-assignment-race-replacement",
                    enabled: true,
                    priority: 0,
                }],
            },
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        })).resolves.toEqual(expect.objectContaining({ id: created.id }));
        await expect(db.automationAssignment.findMany({
            where: { automationId: created.id },
            select: { machineId: true, enabled: true, priority: true },
        })).resolves.toEqual([{
            machineId: "machine-v2-assignment-race-replacement",
            enabled: true,
            priority: 0,
        }]);
    });

    it("bulk clear removes the projection and publishes delete and assignment removal", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-bulk-clear",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Bulk clear",
                description: null,
                enabled: false,
                schedule: {
                    kind: "interval",
                    everyMs: 60_000,
                    timezone: null,
                },
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "clear an unrun Automation" },
                }),
                assignments: [{
                    machineId: "machine-bulk-clear",
                    enabled: true,
                    priority: 0,
                }],
            },
        });

        ioTo.mockClear();
        emit.mockClear();
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({
            status: "applied",
        });

        await expect(db.automation.findUnique({
            where: { id: created.id },
        })).resolves.toBeNull();
        await expect(inTx(async (tx) =>
            await matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "matched" });
        await expect(inTx(async (tx) =>
            await matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "assert_empty" },
            }),
        )).resolves.toEqual({ status: "matched" });
        expect(emit).toHaveBeenCalledWith(
            "update",
            expect.objectContaining({
                body: expect.objectContaining({
                    t: "automation-delete",
                    automationId: created.id,
                }),
            }),
        );
        expect(emit).toHaveBeenCalledWith(
            "update",
            expect.objectContaining({
                body: expect.objectContaining({
                    t: "automation-assignment-updated",
                    machineId: "machine-bulk-clear",
                    automationId: created.id,
                    enabled: false,
                }),
            }),
        );
    });

    it("refuses bulk clear before it can erase retained Run history", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-retained-bulk-clear",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Retained bulk clear",
                description: null,
                enabled: true,
                schedule: {
                    kind: "interval",
                    everyMs: 60_000,
                    timezone: null,
                },
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "retain the queued Run" },
                }),
                assignments: [{ machineId: "machine-retained-bulk-clear" }],
            },
        });
        const retainedRun = await db.automationRun.findFirstOrThrow({
            where: { automationId: created.id },
            select: { id: true },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "not_empty" });

        await expect(db.automation.findUnique({
            where: { id: created.id },
            select: { id: true },
        })).resolves.toEqual({ id: created.id });
        await expect(db.automationRun.findUnique({
            where: { id: retainedRun.id },
            select: { automationId: true },
        })).resolves.toEqual({ automationId: created.id });
    });

    it("owns exact account-migration inventory comparison before writing a template", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        const first = await db.automation.create({
            data: {
                accountId: account.id,
                name: "First migration row",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                templateVersion: 3,
            },
            select: {
                id: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        });
        const second = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Second migration row",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                templateVersion: 7,
            },
            select: {
                id: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: {
                    action: "migrate",
                    templates: [{
                        automationId: first.id,
                        expectedTemplateVersion:
                            first.templateVersion,
                        templateCiphertext: JSON.stringify({
                            kind:
                                "happier_automation_template_encrypted_v1",
                            payloadCiphertext:
                                "replacement-first-template",
                        }),
                    }],
                },
            }),
        )).resolves.toEqual({ status: "migration_incomplete" });

        await expect(db.automation.findMany({
            where: { accountId: account.id },
            orderBy: { id: "asc" },
            select: {
                id: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        })).resolves.toEqual(
            [first, second].sort((left, right) =>
                left.id.localeCompare(right.id)),
        );
    });

    it("advances the migrated template exactly once and publishes its upsert", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Migration post-state",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                templateVersion: 4,
                nextRunAt: new Date("2026-02-12T10:01:00.000Z"),
            },
            select: { id: true, templateVersion: true },
        });
        const replacementTemplate = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "replacement-post-state-template",
        });
        const directive = {
            action: "migrate" as const,
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion:
                    automation.templateVersion,
                templateCiphertext: replacementTemplate,
            }],
        };

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
                nextRunAt: true,
            },
        })).resolves.toEqual({
            templateCiphertext: replacementTemplate,
            templateVersion: automation.templateVersion + 1,
            // Re-sealing Account content changes no scheduling semantics, so
            // the retained next-run projection survives the migration.
            nextRunAt: new Date("2026-02-12T10:01:00.000Z"),
        });
        expect(emit).toHaveBeenCalledWith(
            "update",
            expect.objectContaining({
                body: expect.objectContaining({
                    t: "automation-upsert",
                    automationId: automation.id,
                    version: automation.templateVersion + 1,
                }),
            }),
        );

        await expect(inTx(async (tx) =>
            await matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "matched" });
        await expect(inTx(async (tx) =>
            await matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: {
                    ...directive,
                    templates: [{
                        ...directive.templates[0],
                        templateCiphertext:
                            `${replacementTemplate}-different`,
                    }],
                },
            }),
        )).resolves.toEqual({ status: "mismatch" });
    });

    it("migrates a manual Definition without inventing trigger-definition content", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        const manual = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Manual migration Definition",
                enabled: false,
                triggerKind: "manual",
                scheduleKind: null,
                targetType: "new_session",
                templateCiphertext: buildStrictMigrationRecipe({
                    templateVersion: 1,
                    mode: "e2ee",
                }),
                templateVersion: 1,
            },
            select: { id: true, templateVersion: true },
        });
        const item = buildScheduleMigrationItem(manual);

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "migrate", templates: [item] },
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: manual.id },
            select: {
                triggerKind: true,
                triggerDefinitionEnvelope: true,
                templateVersion: true,
            },
        })).resolves.toEqual({
            triggerKind: "manual",
            triggerDefinitionEnvelope: null,
            templateVersion: manual.templateVersion + 1,
        });
    });

    it("bumps the Event catalog revision once when Account encryption migration rewrites active Event Definitions", async () => {
        const account = await seedEventWriterAccount();
        const activeEvent = await createAutomation({
            accountId: account.id,
            input: {
                name: "Active migration Event",
                enabled: true,
                pluginEvent: eventWriterTrigger("migration-active"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        const disabledEvent = await createAutomation({
            accountId: account.id,
            input: {
                name: "Disabled migration Event",
                enabled: false,
                pluginEvent: eventWriterTrigger("migration-disabled"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        const deletedEvent = await createAutomation({
            accountId: account.id,
            input: {
                name: "Deleted migration Event",
                enabled: false,
                pluginEvent: eventWriterTrigger("migration-deleted"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        await expect(deleteAutomation({
            accountId: account.id,
            automationId: deletedEvent.id,
        })).resolves.toBe(true);
        const schedule = await createAutomation({
            accountId: account.id,
            input: {
                name: "Schedule-only migration Definition",
                enabled: false,
                schedule: {
                    kind: "interval",
                    everyMs: 60_000,
                    timezone: null,
                },
                executionRecipe: eventExecutionRecipe(1),
            },
        });

        // Pin a nonzero revision so this distinguishes one invalidation from
        // per-row invalidations or an omitted catalog projection update.
        await db.automationEventCatalogState.update({
            where: { accountId: account.id },
            data: { eventSourceDefinitionsRevision: 41n },
        });
        const activeItem = buildPluginEventMigrationItem(activeEvent);
        const disabledItem = buildPluginEventMigrationItem(disabledEvent);
        const deletedItem = buildPluginEventMigrationItem(deletedEvent);
        const scheduleItem = buildScheduleMigrationItem(schedule);

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: {
                    action: "migrate",
                    templates: [
                        activeItem,
                        disabledItem,
                        deletedItem,
                        scheduleItem,
                    ],
                },
            }),
        )).resolves.toEqual({ status: "applied" });

        await expect(db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 42n });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: activeEvent.id },
            select: {
                templateVersion: true,
                triggerDefinitionEnvelope: true,
            },
        })).resolves.toEqual({
            templateVersion: activeEvent.templateVersion + 1,
            triggerDefinitionEnvelope: activeItem.triggerDefinitionEnvelope,
        });
    });

    it("does not change the Event catalog revision for Account migration controls without an active Event Definition", async () => {
        const account = await seedEventWriterAccount();
        const disabledEvent = await createAutomation({
            accountId: account.id,
            input: {
                name: "Disabled migration control",
                enabled: false,
                pluginEvent: eventWriterTrigger("control-disabled"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        const deletedEvent = await createAutomation({
            accountId: account.id,
            input: {
                name: "Deleted migration control",
                enabled: false,
                pluginEvent: eventWriterTrigger("control-deleted"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        await expect(deleteAutomation({
            accountId: account.id,
            automationId: deletedEvent.id,
        })).resolves.toBe(true);
        const schedule = await createAutomation({
            accountId: account.id,
            input: {
                name: "Schedule-only migration control",
                enabled: false,
                schedule: {
                    kind: "interval",
                    everyMs: 60_000,
                    timezone: null,
                },
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        await db.automationEventCatalogState.update({
            where: { accountId: account.id },
            data: { eventSourceDefinitionsRevision: 73n },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: {
                    action: "migrate",
                    templates: [
                        buildPluginEventMigrationItem(disabledEvent),
                        buildPluginEventMigrationItem(deletedEvent),
                        buildScheduleMigrationItem(schedule),
                    ],
                },
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 73n });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "assert_empty" },
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 73n });
    });

    it("keeps the Event catalog revision in the Account migration transaction", async () => {
        const account = await seedEventWriterAccount();
        const activeEvent = await createAutomation({
            accountId: account.id,
            input: {
                name: "Rollback-bound migration Event",
                enabled: true,
                pluginEvent: eventWriterTrigger("migration-rollback"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        await db.automationEventCatalogState.update({
            where: { accountId: account.id },
            data: { eventSourceDefinitionsRevision: 91n },
        });
        const directive = {
            action: "migrate" as const,
            templates: [buildPluginEventMigrationItem(activeEvent)],
        };

        await expect(inTx(async (tx) => {
            await expect(migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive,
            })).resolves.toEqual({ status: "applied" });
            throw new Error("injected Account migration rollback");
        })).rejects.toThrow("injected Account migration rollback");

        await expect(db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 91n });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: activeEvent.id },
            select: {
                templateVersion: true,
                triggerDefinitionEnvelope: true,
            },
        })).resolves.toEqual({
            templateVersion: activeEvent.templateVersion,
            triggerDefinitionEnvelope: activeEvent.triggerDefinitionEnvelope,
        });
    });

    it("bumps the Event catalog revision once when Account encryption clear removes active Event Definitions", async () => {
        const account = await seedEventWriterAccount();
        await createAutomation({
            accountId: account.id,
            input: {
                name: "First active clear Event",
                enabled: true,
                pluginEvent: eventWriterTrigger("clear-active-one"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        await createAutomation({
            accountId: account.id,
            input: {
                name: "Second active clear Event",
                enabled: true,
                pluginEvent: eventWriterTrigger("clear-active-two"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        await createAutomation({
            accountId: account.id,
            input: {
                name: "Disabled clear control",
                enabled: false,
                pluginEvent: eventWriterTrigger("clear-disabled"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        await db.automationEventCatalogState.update({
            where: { accountId: account.id },
            data: { eventSourceDefinitionsRevision: 101n },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 102n });

        const disabledEvent = await createAutomation({
            accountId: account.id,
            input: {
                name: "Disabled clear-only control",
                enabled: false,
                pluginEvent: eventWriterTrigger("clear-control-disabled"),
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        await expect(deleteAutomation({
            accountId: account.id,
            automationId: disabledEvent.id,
        })).resolves.toBe(true);
        await createAutomation({
            accountId: account.id,
            input: {
                name: "Schedule-only clear control",
                enabled: false,
                schedule: {
                    kind: "interval",
                    everyMs: 60_000,
                    timezone: null,
                },
                executionRecipe: eventExecutionRecipe(1),
            },
        });
        await db.automationEventCatalogState.update({
            where: { accountId: account.id },
            data: { eventSourceDefinitionsRevision: 151n },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "assert_empty" },
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automationEventCatalogState.findUnique({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 151n });
    });

    it("migrates a strict definition with only its mode-bound envelopes and version advanced", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const sourceTemplate = buildStrictMigrationRecipe({
            templateVersion: 4,
            mode: "plain",
        });
        const replacementTemplate = buildStrictMigrationRecipe({
            templateVersion: 5,
            mode: "e2ee",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Strict migration definition",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: sourceTemplate,
                templateVersion: 4,
            },
            select: { id: true, templateVersion: true },
        });
        const directive = {
            action: "migrate" as const,
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: automation.templateVersion,
                templateCiphertext: replacementTemplate,
            }],
        };

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                targetType: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        })).resolves.toEqual({
            targetType: "new_session",
            templateCiphertext: replacementTemplate,
            templateVersion: automation.templateVersion + 1,
        });
        await expect(inTx(async (tx) =>
            await matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "matched" });
    });

    it("migrates a strict definition to a plain target only when both Definition recipes retain null trigger evidence", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const sourceTemplate = buildStrictMigrationRecipe({
            templateVersion: 4,
            mode: "e2ee",
        });
        const replacementTemplate = buildStrictMigrationRecipe({
            templateVersion: 5,
            mode: "plain",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Strict plain migration definition",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: sourceTemplate,
                templateVersion: 4,
            },
            select: { id: true, templateVersion: true },
        });
        const directive = {
            action: "migrate" as const,
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: automation.templateVersion,
                templateCiphertext: replacementTemplate,
            }],
        };

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "plain",
                directive,
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(inTx(async (tx) =>
            await matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "plain",
                directive,
            }),
        )).resolves.toEqual({ status: "matched" });
    });

    it.each(["source", "target"] as const)("rejects strict migration %s trigger evidence before mutating the Definition", async (corruptSide) => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const sourceTemplate = buildStrictMigrationRecipe({
            templateVersion: 4,
            mode: "plain",
            ...(corruptSide === "source"
                ? { triggerEvidence: { t: "plain" as const, v: { v: 1, kind: "must-not-live-on-definition" } } }
                : {}),
        });
        const replacementTemplate = buildStrictMigrationRecipe({
            templateVersion: 5,
            mode: "e2ee",
            ...(corruptSide === "target"
                ? { triggerEvidence: { t: "encrypted" as const, c: "must-not-live-on-definition" } }
                : {}),
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: `Strict ${corruptSide} evidence definition`,
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: sourceTemplate,
                templateVersion: 4,
            },
            select: { id: true, templateVersion: true },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: {
                    action: "migrate",
                    templates: [{
                        automationId: automation.id,
                        expectedTemplateVersion: automation.templateVersion,
                        templateCiphertext: replacementTemplate,
                    }],
                },
            }),
        )).resolves.toEqual({ status: "invalid_content" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: { templateCiphertext: true, templateVersion: true },
        })).resolves.toEqual({
            templateCiphertext: sourceTemplate,
            templateVersion: automation.templateVersion,
        });
    });

    it("treats a strict replay with Definition trigger evidence as a mismatch without a write", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const replayTemplate = buildStrictMigrationRecipe({
            templateVersion: 5,
            mode: "e2ee",
            triggerEvidence: { t: "encrypted", c: "invalid-definition-evidence" },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Strict replay evidence definition",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: replayTemplate,
                templateVersion: 5,
            },
            select: { id: true },
        });
        const directive = {
            action: "migrate" as const,
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: 4,
                templateCiphertext: replayTemplate,
            }],
        };

        await expect(inTx(async (tx) =>
            await matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "mismatch" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: { templateCiphertext: true, templateVersion: true },
        })).resolves.toEqual({
            templateCiphertext: replayTemplate,
            templateVersion: 5,
        });
    });

    it("rejects a strict migration replacement that changes its target arm", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const sourceTemplate = buildStrictMigrationRecipe({
            templateVersion: 4,
            mode: "plain",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Strict target preservation",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: sourceTemplate,
                templateVersion: 4,
            },
            select: { id: true, templateVersion: true },
        });
        const replacementTemplate = buildStrictMigrationRecipe({
            templateVersion: 5,
            mode: "e2ee",
            target: {
                ...STRICT_MIGRATION_NEW_SESSION_TARGET,
                spawn: {
                    ...STRICT_MIGRATION_NEW_SESSION_TARGET.spawn,
                    executionTarget: {
                        ...STRICT_MIGRATION_NEW_SESSION_TARGET.spawn.executionTarget,
                        machineId: "different-machine",
                    },
                },
            },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: {
                    action: "migrate",
                    templates: [{
                        automationId: automation.id,
                        expectedTemplateVersion: automation.templateVersion,
                        templateCiphertext: replacementTemplate,
                    }],
                },
            }),
        )).resolves.toEqual({ status: "invalid_content" });
    });

    it("requires a strict migration replacement recipe to carry the next template version", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const sourceTemplate = buildStrictMigrationRecipe({
            templateVersion: 4,
            mode: "plain",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Strict template version preservation",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: sourceTemplate,
                templateVersion: 4,
            },
            select: { id: true, templateVersion: true },
        });
        const replacementTemplate = buildStrictMigrationRecipe({
            templateVersion: automation.templateVersion,
            mode: "e2ee",
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: {
                    action: "migrate",
                    templates: [{
                        automationId: automation.id,
                        expectedTemplateVersion: automation.templateVersion,
                        templateCiphertext: replacementTemplate,
                    }],
                },
            }),
        )).resolves.toEqual({ status: "invalid_content" });
    });

    it("retains an exact predecessor encrypted existing-session template across account migration replay", async () => {
        const account = await db.account.create({
            data: {
                publicKey:
                    "pk-automation-migration-retained-predecessor-template",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: "automation-migration-retained-predecessor-session",
                accountId: account.id,
                encryptionMode: "e2ee",
                metadata: "opaque-ciphertext-metadata",
                active: true,
            },
            select: { id: true },
        });
        const templateCiphertext =
            buildLegacyTemplateEnvelope(session.id);
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Retained predecessor migration row",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "existing_session",
                templateCiphertext,
                templateVersion: 5,
            },
            select: { id: true, templateVersion: true },
        });
        const directive = {
            action: "migrate" as const,
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: automation.templateVersion,
                templateCiphertext,
            }],
        };

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
            },
        })).resolves.toEqual({
            templateCiphertext,
            templateVersion: automation.templateVersion + 1,
        });
        await expect(inTx(async (tx) =>
            await matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "matched" });
    });

    it("rejects predecessor envelope bytes introduced by an account migration", async () => {
        const account = await db.account.create({
            data: {
                publicKey:
                    "pk-automation-migration-rejects-new-predecessor-bytes",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const storedSession = await db.session.create({
            data: {
                tag: "automation-migration-stored-predecessor-session",
                accountId: account.id,
                encryptionMode: "e2ee",
                metadata: "opaque-stored-session-metadata",
                active: true,
            },
            select: { id: true },
        });
        const injectedSession = await db.session.create({
            data: {
                tag: "automation-migration-injected-predecessor-session",
                accountId: account.id,
                encryptionMode: "e2ee",
                metadata: "opaque-injected-session-metadata",
                active: true,
            },
            select: { id: true },
        });
        const storedTemplateCiphertext =
            buildLegacyTemplateEnvelope(storedSession.id);
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Current migration row",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "existing_session",
                templateCiphertext: storedTemplateCiphertext,
                templateVersion: 2,
            },
            select: { id: true, templateVersion: true },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: {
                    action: "migrate",
                    templates: [{
                        automationId: automation.id,
                        expectedTemplateVersion: automation.templateVersion,
                        templateCiphertext:
                            buildLegacyTemplateEnvelope(injectedSession.id),
                    }],
                },
            }),
        )).resolves.toEqual({ status: "invalid_content" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
            },
        })).resolves.toEqual({
            templateCiphertext: storedTemplateCiphertext,
            templateVersion: automation.templateVersion,
        });
    });

    it("updates queued run dueAt (and nextRunAt) when schedule is changed", async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-02-12T10:00:00.000Z"));

            const account = await db.account.create({
                data: createSignedAccountContentBinding(),
                select: { id: true },
            });
            await db.machine.create({
                data: {
                    id: "machine-1",
                    accountId: account.id,
                    metadata: "{}",
                },
            });

            const created = await createAutomation({
                accountId: account.id,
                input: {
                    name: "Schedule update",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "new_session",
                    templateCiphertext: buildTemplateEnvelope(),
                    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                },
            });

            const queuedBefore = await db.automationRun.findFirst({
                where: { automationId: created.id, state: "queued" },
                orderBy: [{ dueAt: "asc" }],
                select: { id: true, dueAt: true },
            });
            expect(queuedBefore?.dueAt.toISOString()).toBe("2026-02-12T10:01:00.000Z");

            const updated = await updateAutomation({
                accountId: account.id,
                automationId: created.id,
                input: {
                    schedule: { kind: "interval", everyMs: 120_000, timezone: null },
                },
            });
            expect(updated).not.toBeNull();

            const queuedAfter = await db.automationRun.findFirst({
                where: { automationId: created.id, state: "queued" },
                orderBy: [{ dueAt: "asc" }],
                select: { id: true, dueAt: true },
            });
            expect(queuedAfter?.id).toBe(queuedBefore?.id);
            expect(queuedAfter?.dueAt.toISOString()).toBe("2026-02-12T10:02:00.000Z");

            const automationRow = await db.automation.findUnique({
                where: { id: created.id },
                select: { nextRunAt: true },
            });
            expect(automationRow?.nextRunAt?.toISOString()).toBe("2026-02-12T10:02:00.000Z");
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects existing_session automation when target session does not exist or is not resumable", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        await expect(() =>
            createAutomation({
                accountId: account.id,
                input: {
                    name: "Existing session missing",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "existing_session",
                    templateCiphertext: buildLegacyTemplateEnvelope("missing-session"),
                    legacyTemplateEnvelopeAdmission:
                        legacyTemplateEnvelopeAdmission("missing-session"),
                    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                },
            }),
        ).rejects.toThrow(/existing session/i);

        const unsupportedSession = await db.session.create({
            data: {
                tag: "unsupported-session",
                accountId: account.id,
                metadata: JSON.stringify({ flavor: "unknown-local-backend" }),
                active: true,
            },
            select: { id: true },
        });

        await expect(() =>
            createAutomation({
                accountId: account.id,
                input: {
                    name: "Existing session unsupported",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "existing_session",
                    templateCiphertext: buildLegacyTemplateEnvelope(unsupportedSession.id),
                    legacyTemplateEnvelopeAdmission:
                        legacyTemplateEnvelopeAdmission(unsupportedSession.id),
                    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                },
            }),
        ).rejects.toThrow(/resume|resum/i);
    });

    it("allows existing_session automation for a resumable target even when inactive and rejects invalid target updates", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const activeSession = await db.session.create({
            data: {
                tag: "active-session",
                accountId: account.id,
                metadata: JSON.stringify({
                    flavor: "claude",
                    claudeSessionId: "claude-session-1",
                    claudeTranscriptPath: "/tmp/claude-session-1.jsonl",
                }),
                active: false,
            },
            select: { id: true },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Existing session valid",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "existing_session",
                templateCiphertext: buildLegacyTemplateEnvelope(activeSession.id),
                legacyTemplateEnvelopeAdmission:
                    legacyTemplateEnvelopeAdmission(activeSession.id),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        expect(created.targetType).toBe("existing_session");

        await expect(() =>
            updateAutomation({
                accountId: account.id,
                automationId: created.id,
                input: {
                    templateCiphertext: buildLegacyTemplateEnvelope("missing-session-after-create"),
                    legacyTemplateEnvelopeAdmission:
                        legacyTemplateEnvelopeAdmission("missing-session-after-create"),
                },
            }),
        ).rejects.toThrow(/existing session/i);
    });

    it("accepts an exact predecessor plain existing-session template through the trusted legacy admission", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-automation-crud-legacy-plain-existing-session",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-legacy-plain-existing-session",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const session = await db.session.create({
            data: {
                tag: "legacy-plain-existing-session",
                accountId: account.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({
                    flavor: "claude",
                    claudeSessionId: "legacy-plain-existing-session",
                    claudeTranscriptPath: "/tmp/legacy-plain-existing-session.jsonl",
                }),
                active: false,
            },
            select: { id: true },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Legacy plain existing session",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "existing_session",
                templateCiphertext: buildLegacyPlainTemplateEnvelope(session.id),
                legacyTemplateEnvelopeAdmission:
                    legacyPlainTemplateEnvelopeAdmission(session.id),
                assignments: [{
                    machineId: "machine-legacy-plain-existing-session",
                    enabled: true,
                    priority: 0,
                }],
            },
        });

        expect(created.targetType).toBe("existing_session");
        expect(created.templateCiphertext).toBe(
            buildLegacyPlainTemplateEnvelope(session.id),
        );
    });

    it("advances the template version when targetType changes without replacement ciphertext", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-target-version",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const session = await db.session.create({
            data: {
                tag: "target-version-session",
                accountId: account.id,
                metadata: JSON.stringify({
                    flavor: "claude",
                    claudeSessionId: "target-version-session",
                    claudeTranscriptPath: "/tmp/target-version-session.jsonl",
                }),
                active: false,
            },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Target version",
                description: null,
                enabled: true,
                schedule: {
                    kind: "interval",
                    everyMs: 60_000,
                    timezone: null,
                },
                targetType: "existing_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{
                    machineId: "machine-target-version",
                    enabled: true,
                    priority: 0,
                }],
            },
        });

        const updated = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: { targetType: "new_session" },
        });

        expect(updated).toMatchObject({
            targetType: "new_session",
            templateVersion: created.templateVersion + 1,
        });
    });

    it("rejects a migration prepared before a targetType edit", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-migration-target-race",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const session = await db.session.create({
            data: {
                tag: "migration-target-race-session",
                accountId: account.id,
                metadata: JSON.stringify({
                    flavor: "claude",
                    claudeSessionId: "migration-target-race-session",
                    claudeTranscriptPath:
                        "/tmp/migration-target-race-session.jsonl",
                }),
                active: false,
            },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Migration target race",
                description: null,
                enabled: true,
                schedule: {
                    kind: "interval",
                    everyMs: 60_000,
                    timezone: null,
                },
                targetType: "existing_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{
                    machineId: "machine-migration-target-race",
                    enabled: true,
                    priority: 0,
                }],
            },
        });

        await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: { targetType: "new_session" },
        });

        const replacementTemplate = buildTemplateEnvelope();
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: {
                    action: "migrate",
                    templates: [{
                        automationId: created.id,
                        expectedTemplateVersion:
                            created.templateVersion,
                        templateCiphertext: replacementTemplate,
                    }],
                },
            }))).rejects.toBeInstanceOf(
                AutomationAccountEncryptionMigrationConflictError,
            );
        await expect(db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: {
                targetType: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        })).resolves.toEqual({
            targetType: "new_session",
            templateCiphertext: created.templateCiphertext,
            templateVersion: created.templateVersion + 1,
        });
    });

    it("rejects a targetType edit when the validated template changes before its write", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-target-write-race",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const session = await db.session.create({
            data: {
                tag: "target-write-race-session",
                accountId: account.id,
                metadata: JSON.stringify({
                    flavor: "claude",
                    claudeSessionId: "target-write-race-session",
                    claudeTranscriptPath:
                        "/tmp/target-write-race-session.jsonl",
                }),
                active: false,
            },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Target write race",
                description: null,
                enabled: true,
                schedule: {
                    kind: "interval",
                    everyMs: 60_000,
                    timezone: null,
                },
                targetType: "existing_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{
                    machineId: "machine-target-write-race",
                    enabled: true,
                    priority: 0,
                }],
            },
        });
        const race = installAutomationSemanticMutationRace({
            automationId: created.id,
            replacementTemplateCiphertext:
                buildTemplateEnvelope(),
        });
        try {
            await expect(updateAutomation({
                accountId: account.id,
                automationId: created.id,
                input: { targetType: "new_session" },
            })).rejects.toBeInstanceOf(
                AutomationTemplateMutationConflictError,
            );
        } finally {
            race.restore();
        }

        await expect(db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: {
                targetType: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        })).resolves.toEqual({
            targetType: "existing_session",
            templateCiphertext: created.templateCiphertext,
            templateVersion: created.templateVersion,
        });
    });

    it("allows a plain account to retain an encrypted template only for an opaque e2ee existing session", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-automation-crud-existing-session-e2ee-validation",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const encryptedSession = await db.session.create({
            data: {
                tag: "encrypted-session",
                accountId: account.id,
                encryptionMode: "e2ee",
                metadata: "opaque-ciphertext-metadata",
                active: true,
            },
            select: { id: true },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Existing session e2ee",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "existing_session",
                templateCiphertext: buildLegacyTemplateEnvelope(encryptedSession.id),
                legacyTemplateEnvelopeAdmission:
                    legacyTemplateEnvelopeAdmission(encryptedSession.id),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        expect(created.targetType).toBe("existing_session");
    });

    it("rejects changing a retained encrypted template to a new-session target in a plain account", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-automation-crud-target-transition",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const encryptedSession = await db.session.create({
            data: {
                tag: "encrypted-session-target-transition",
                accountId: account.id,
                encryptionMode: "e2ee",
                metadata: "opaque-ciphertext-metadata",
                active: true,
            },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Existing encrypted session",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "existing_session",
                templateCiphertext: buildLegacyTemplateEnvelope(encryptedSession.id),
                legacyTemplateEnvelopeAdmission:
                    legacyTemplateEnvelopeAdmission(encryptedSession.id),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: { targetType: "new_session" },
        })).rejects.toThrow(/reserved for existing_session targets/i);

        await expect(db.automation.findUnique({
            where: { id: created.id },
            select: { targetType: true, templateCiphertext: true },
        })).resolves.toEqual({
            targetType: "existing_session",
            templateCiphertext: created.templateCiphertext,
        });
    });

    it("rejects an encrypted template for a plain existing session in a plain account", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-automation-crud-existing-session-plain-validation",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const plainSession = await db.session.create({
            data: {
                tag: "plain-session",
                accountId: account.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({
                    flavor: "claude",
                    claudeSessionId: "claude-session-plain",
                }),
                active: true,
            },
            select: { id: true },
        });

        await expect(createAutomation({
            accountId: account.id,
            input: {
                name: "Invalid encrypted plain-session template",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "existing_session",
                templateCiphertext: buildLegacyTemplateEnvelope(plainSession.id),
                legacyTemplateEnvelopeAdmission:
                    legacyTemplateEnvelopeAdmission(plainSession.id),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        })).rejects.toThrow(/encrypted.*e2ee|plain session/i);

        expect(await db.automation.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("rejects existing_session automation when account settings disable the target backend", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                settings: JSON.stringify({
                    t: "plain",
                    v: {
                        backendEnabledByTargetKey: {
                            [buildBackendTargetKey({ kind: "builtInAgent", agentId: "claude" })]: false,
                        },
                    },
                }),
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const disabledSession = await db.session.create({
            data: {
                tag: "disabled-session",
                accountId: account.id,
                metadata: JSON.stringify({ flavor: "claude", claudeSessionId: "claude-session-disabled" }),
                active: true,
            },
            select: { id: true },
        });

        await expect(() =>
            createAutomation({
                accountId: account.id,
                input: {
                    name: "Existing session disabled",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "existing_session",
                    templateCiphertext: buildLegacyTemplateEnvelope(disabledSession.id),
                    legacyTemplateEnvelopeAdmission:
                        legacyTemplateEnvelopeAdmission(disabledSession.id),
                    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                },
            }),
        ).rejects.toThrow(/resum|backend/i);
    });

    it("rejects assignments that target machines outside of the account with AutomationValidationError", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-owned",
                accountId: account.id,
                metadata: "{}",
            },
        });

        await expect(() =>
            createAutomation({
                accountId: account.id,
                input: {
                    name: "Invalid assignment automation",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "new_session",
                    templateCiphertext: buildTemplateEnvelope(),
                    assignments: [{ machineId: "machine-not-owned", enabled: true, priority: 0 }],
                },
            }),
        ).rejects.toBeInstanceOf(AutomationValidationError);
    });
});
