import {
    ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS,
    AccountEncryptionMigrateAutomationsDirectiveSchema,
    deriveAutomationOccurrenceKeyV1,
    AutomationSourceSelectorIdV1Schema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationRunExecutionRecipeV1,
    type PluginJsonValueV2,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { verifyAccountContentKeyBindingForAccountPublicKey } from "@/app/encryption/accountContentKeyAdmission";
import { applyAccountEncryptionTransitionInTx } from "@/app/encryption/accountEncryptionTransition";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    AutomationAccountEncryptionMigrationConflictError,
    applyAutomationAccountEncryptionTransitionStageInTx,
    inspectAutomationAccountEncryptionTransitionInTx,
    matchAutomationAccountEncryptionMigrationPostStateInTx,
    migrateAutomationAccountEncryptionInTx,
    validateAutomationAccountEncryptionTransitionStageInTx,
} from "./automationCrudService";
import { claimAutomationRun, heartbeatAutomationRun } from "./automationClaimService";
import { cancelAutomationRun } from "./automationRunService";
import { assertAllOriginAutomationRunMigrationToE2ee } from "./automationAccountEncryptionMigrationRuns.testkit";

const SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "8a2e26d2-5b2b-4e9b-a57f-68ca5e575dc7",
);
const E2EE_TAG = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TRIGGER_DEFINITION_MATERIAL = {
    type: "dataKey" as const,
    machineKey: new Uint8Array(32).fill(9),
};

function buildTriggerDefinitionEnvelope(params: Readonly<{
    automationId: string;
    templateVersion: number;
    triggerKind: "pluginEvent";
    mode: "plain" | "e2ee";
}>): string {
    const binding = {
        v: 1 as const,
        automationId: params.automationId,
        templateVersion: params.templateVersion,
        triggerKind: "pluginEvent" as const,
        eventRef: {
            pluginId: "com.example.github",
            localId: "repository-event",
        },
        sourceSelectorId: SOURCE_SELECTOR_ID,
    };
    const definition: PluginJsonValueV2 = {
        v: 1,
        sourceInstanceId: "migration-repository",
        sourceConfig: { repositoryId: 42 },
        displayLabel: "Migration repository",
        filter: null,
        maximumObservationAgeMs: null,
    };
    return JSON.stringify(params.mode === "plain"
        ? sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding,
            definition,
        })
        : sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "e2ee",
            binding,
            definition,
            material: TRIGGER_DEFINITION_MATERIAL,
            randomBytes: (length) => new Uint8Array(length).fill(6),
        }));
}

function buildPlainEventEvidence() {
    return {
        v: 1 as const,
        kind: "pluginEvent" as const,
        eventRef: {
            pluginId: "com.example.github",
            localId: "repository-event",
        },
        sourceSelectorId: SOURCE_SELECTOR_ID,
        occurrenceId: "migration-event-1",
        occurredAt: 1_724_000_000_000,
        payload: { action: "opened", repository: { id: 42 } },
    };
}

function buildPlainConversationEvidence() {
    return {
        v: 1 as const,
        kind: "conversation" as const,
        bindingId: "binding-account-encryption-migration",
        occurrenceId: "migration-conversation-1",
        occurredAt: 1_724_000_001_000,
        caller: {
            pluginId: "happier.channels",
            contributionLocalId: "provider/observation-ingest-v1",
            machineId: "machine-account-encryption-migration",
        },
        input: { text: "migrate this conversation" },
        replyContextIdentity: "reply-context-account-encryption-migration",
    };
}

function buildPlainTemplate(prompt: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_plain_v1",
        payload: { prompt },
    });
}

function buildEncryptedTemplate(ciphertext: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: ciphertext,
    });
}

function buildExecutionInput(params: Readonly<{
    templateCiphertext: string;
    origin:
        | Readonly<{ kind: "scheduled"; scheduledFor: number }>
        | Readonly<{ kind: "manual"; invokedAt: number }>;
}>): string {
    return JSON.stringify({
        kind: "happier_automation_run_execution_input_v1",
        targetType: "new_session",
        templateVersion: 1,
        templateCiphertext: params.templateCiphertext,
        origin: params.origin,
    });
}

function buildStrictExecutionInput(recipe: unknown): string {
    const serialized = serializeAutomationRunExecutionRecipeV1(recipe);
    if (serialized.kind !== "available") {
        throw new Error("Migration fixture must use a valid strict Run recipe");
    }
    return serialized.serialized;
}

function strictRunTarget() {
    return {
        kind: "newSession" as const,
        spawn: {
            executionTarget: {
                serverId: "server-account-encryption-migration",
                machineId: "machine-account-encryption-migration",
            },
            directory: "/tmp/account-encryption-migration",
            agentTarget: {
                kind: "agent" as const,
                identity: {
                    pluginId: "happier.agent.codex",
                    localId: "codex",
                },
            },
        },
    };
}

function buildStrictPlainEventOrConversationExecutionInput(params: Readonly<{
    templateVersion: number;
    prompt: string;
    evidence: unknown;
}>): string {
    return buildStrictExecutionInput({
        v: 1,
        templateVersion: params.templateVersion,
        template: { t: "plain", v: { v: 1, prompt: params.prompt } },
        triggerEvidence: { t: "plain", v: params.evidence },
        target: strictRunTarget(),
    });
}

function buildStrictEncryptedEventOrConversationExecutionInput(params: Readonly<{
    runId: string;
    templateVersion: number;
}>): string {
    return buildStrictExecutionInput({
        v: 1,
        templateVersion: params.templateVersion,
        template: {
            t: "encrypted",
            c: "replacement-encrypted-execution-input-" + params.runId,
        },
        triggerEvidence: {
            t: "encrypted",
            c: "replacement-encrypted-evidence-" + params.runId,
        },
        target: strictRunTarget(),
    });
}

function buildPlainResultEnvelope(params: Readonly<{
    accountId: string;
    automationId: string;
    runId: string;
    handoffId: string;
}>): string {
    return JSON.stringify({
        t: "plain",
        v: {
            v: 1,
            correspondence: params,
            result: { v: 1, kind: "text", text: "Automation completed" },
        },
    });
}

function buildPlainReplyContextEnvelope(params: Readonly<{
    automationId: string;
    occurrenceKey: string;
}>, templateVersion: number): string {
    return JSON.stringify({
        t: "plain",
        v: {
            v: 1,
            correspondence: params,
            templateVersion,
            opaqueContext: {
                conversationId: "conversation-account-encryption-migration",
            },
        },
    });
}

function buildPlainReplyReceiptEnvelope(params: Readonly<{
    accountId: string;
    automationId: string;
    runId: string;
    handoffId: string;
}>): string {
    return JSON.stringify({
        t: "plain",
        v: {
            v: 1,
            correspondence: params,
            result: {
                kind: "accepted",
                custodyId: "custody-account-encryption-migration",
            },
        },
    });
}

const migrationRunContentSelect = {
    id: true,
    revision: true,
    triggerEvidenceEnvelope: true,
    occurrenceEvidenceEqualityTag: true,
    executionInputEnvelope: true,
    resultEnvelope: true,
    replyContextEnvelope: true,
    replyHandoffReceiptEnvelope: true,
    summaryCiphertext: true,
} as const;

async function seedAutomationRuns() {
    const account = await db.account.create({
        data: { encryptionMode: "plain" },
        select: { id: true },
    });
    const eventAutomationId = "automation-account-encryption-migration-event";
    const eventAutomation = await db.automation.create({
        data: {
            id: eventAutomationId,
            accountId: account.id,
            name: "Event evidence migration",
            enabled: false,
            triggerKind: "pluginEvent",
            triggerEventPluginId: "com.example.github",
            triggerEventLocalId: "repository-event",
            triggerSourceSelectorId: SOURCE_SELECTOR_ID,
            triggerSourceContractVersion: 1,
            triggerObservationTransport: "checkpointedPull",
            triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
                automationId: eventAutomationId,
                templateVersion: 4,
                triggerKind: "pluginEvent",
                mode: "plain",
            }),
            targetType: "new_session",
            templateCiphertext: buildPlainTemplate("migrate Event Run"),
            templateVersion: 4,
        },
        select: { id: true, templateVersion: true, templateCiphertext: true },
    });
    const conversationAutomationId = "automation-account-encryption-migration-conversation";
    const conversationAutomation = await db.automation.create({
        data: {
            id: conversationAutomationId,
            accountId: account.id,
            name: "Conversation evidence migration",
            enabled: false,
            // Conversation is retained as the Run origin below, not a definition trigger.
            triggerKind: "schedule",
            scheduleKind: "interval",
            everyMs: 60_000,
            triggerDefinitionEnvelope: null,
            targetType: "new_session",
            templateCiphertext: buildPlainTemplate("migrate Conversation Run"),
            templateVersion: 6,
        },
        select: { id: true, templateVersion: true, templateCiphertext: true },
    });
    const replyMachine = await db.machine.create({
        data: {
            id: "machine-account-encryption-migration",
            accountId: account.id,
            metadata: "{}",
        },
        select: { id: true },
    });
    const eventEvidence = buildPlainEventEvidence();
    const eventRunId = "run-account-encryption-event";
    const eventRun = await db.automationRun.create({
        data: {
            id: eventRunId,
            automationId: eventAutomation.id,
            accountId: account.id,
            state: "queued",
            originKind: "pluginEvent",
            originOccurredAt: new Date(eventEvidence.occurredAt),
            occurrenceKey: deriveAutomationOccurrenceKeyV1(eventEvidence),
            occurrenceEvidenceEqualityTag: null,
            originSourceSelectorId: SOURCE_SELECTOR_ID,
            triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: eventEvidence }),
            executionInputEnvelope: buildStrictPlainEventOrConversationExecutionInput({
                templateVersion: eventAutomation.templateVersion,
                prompt: "migrate Event Run",
                evidence: eventEvidence,
            }),
            resultEnvelope: buildPlainResultEnvelope({
                accountId: account.id,
                automationId: eventAutomation.id,
                runId: eventRunId,
                handoffId: "handoff-account-encryption-event",
            }),
            scheduledAt: new Date("2026-08-10T10:00:00.000Z"),
            dueAt: new Date("2026-08-10T10:00:00.000Z"),
        },
        select: migrationRunContentSelect,
    });
    const conversationEvidence = buildPlainConversationEvidence();
    const conversationRunId = "run-account-encryption-conversation";
    const conversationCorrespondence = {
        accountId: account.id,
        automationId: conversationAutomation.id,
        runId: conversationRunId,
        handoffId: "handoff-account-encryption-conversation",
    };
    const conversationOccurrenceKey = deriveAutomationOccurrenceKeyV1(conversationEvidence);
    const conversationRun = await db.automationRun.create({
        data: {
            id: conversationRunId,
            automationId: conversationAutomation.id,
            accountId: account.id,
            state: "succeeded",
            originKind: "conversation",
            originOccurredAt: new Date(conversationEvidence.occurredAt),
            occurrenceKey: conversationOccurrenceKey,
            occurrenceEvidenceEqualityTag: null,
            triggerEvidenceEnvelope: JSON.stringify({
                t: "plain",
                v: conversationEvidence,
            }),
            executionInputEnvelope: buildStrictPlainEventOrConversationExecutionInput({
                templateVersion: conversationAutomation.templateVersion,
                prompt: "migrate Conversation Run",
                evidence: conversationEvidence,
            }),
            resultEnvelope: buildPlainResultEnvelope(conversationCorrespondence),
            replyContextEnvelope: buildPlainReplyContextEnvelope(
                {
                    automationId: conversationCorrespondence.automationId,
                    occurrenceKey: conversationOccurrenceKey,
                },
                conversationAutomation.templateVersion,
            ),
            replyHandoffActionPluginId: "happier.channels",
            replyHandoffActionLocalId: "automation/result-deliver-v1",
            replyHandoffTargetMachineId: replyMachine.id,
            replyHandoffTargetMachineInstallationId:
                "installation-account-encryption-migration",
            replyHandoffTargetMaterializationId:
                "materialization-account-encryption-migration",
            replyHandoffId: conversationCorrespondence.handoffId,
            replyHandoffState: "accepted",
            replyHandoffReceiptEnvelope: buildPlainReplyReceiptEnvelope(
                conversationCorrespondence,
            ),
            scheduledAt: new Date("2026-08-10T10:01:00.000Z"),
            dueAt: new Date("2026-08-10T10:01:00.000Z"),
            finishedAt: new Date("2026-08-10T10:02:00.000Z"),
        },
        select: migrationRunContentSelect,
    });
    const scheduledRun = await db.automationRun.create({
        data: {
            id: "run-account-encryption-scheduled",
            automationId: eventAutomation.id,
            accountId: account.id,
            state: "queued",
            originKind: "scheduled",
            originOccurredAt: null,
            executionInputEnvelope: buildExecutionInput({
                templateCiphertext: eventAutomation.templateCiphertext,
                origin: {
                    kind: "scheduled",
                    scheduledFor: new Date("2026-08-10T10:03:00.000Z").getTime(),
                },
            }),
            scheduledAt: new Date("2026-08-10T10:03:00.000Z"),
            dueAt: new Date("2026-08-10T10:03:00.000Z"),
        },
        select: migrationRunContentSelect,
    });
    const manualRun = await db.automationRun.create({
        data: {
            id: "run-account-encryption-manual",
            automationId: eventAutomation.id,
            accountId: account.id,
            state: "succeeded",
            originKind: "manual",
            originOccurredAt: null,
            executionInputEnvelope: buildExecutionInput({
                templateCiphertext: eventAutomation.templateCiphertext,
                origin: { kind: "manual", invokedAt: 1_723_247_201_000 },
            }),
            resultEnvelope: JSON.stringify({
                t: "legacySummaryCiphertext",
                c: "manual-predecessor-summary",
            }),
            summaryCiphertext: "manual-predecessor-summary",
            scheduledAt: new Date("2026-08-10T10:04:00.000Z"),
            dueAt: new Date("2026-08-10T10:04:00.000Z"),
            finishedAt: new Date("2026-08-10T10:05:00.000Z"),
        },
        select: migrationRunContentSelect,
    });

    return {
        account,
        eventAutomation,
        conversationAutomation,
        eventRun,
        conversationRun,
        scheduledRun,
        manualRun,
    };
}

function buildEncryptedRunMigrationItem(params: Readonly<{
    runId: string;
    expectedRunRevision: number;
    originKind: "pluginEvent" | "conversation" | "scheduled" | "manual";
    templateVersion: number;
    retainsOccurrenceEvidence: boolean;
    resultEnvelope: string | null;
    replyContextEnvelope: string | null;
    replyHandoffReceiptEnvelope: string | null;
}>) {
    return {
        runId: params.runId,
        expectedRunRevision: params.expectedRunRevision,
        triggerEvidenceEnvelope: params.retainsOccurrenceEvidence
            ? JSON.stringify({
                t: "encrypted",
                c: "replacement-encrypted-evidence-" + params.runId,
            })
            : null,
        occurrenceEvidenceEqualityTag: params.retainsOccurrenceEvidence
            ? E2EE_TAG
            : null,
        executionInputEnvelope:
            params.originKind === "pluginEvent" || params.originKind === "conversation"
                ? buildStrictEncryptedEventOrConversationExecutionInput({
                    runId: params.runId,
                    templateVersion: params.templateVersion,
                })
                : buildExecutionInput({
                    templateCiphertext: buildEncryptedTemplate(
                        "replacement-encrypted-execution-input-" + params.runId,
                    ),
                    origin: params.originKind === "scheduled"
                        ? {
                            kind: "scheduled",
                            scheduledFor: new Date("2026-08-10T10:03:00.000Z").getTime(),
                        }
                        : { kind: "manual", invokedAt: 1_723_247_201_000 },
                }),
        resultEnvelope: params.resultEnvelope === null
            ? null
            : JSON.stringify({
                t: "encrypted",
                c: "replacement-encrypted-result-" + params.runId,
            }),
        replyContextEnvelope: params.replyContextEnvelope === null
            ? null
            : JSON.stringify({
                t: "encrypted",
                c: "replacement-encrypted-reply-context-" + params.runId,
            }),
        replyHandoffReceiptEnvelope: params.replyHandoffReceiptEnvelope === null
            ? null
            : JSON.stringify({
                t: "encrypted",
                c: "replacement-encrypted-receipt-" + params.runId,
            }),
    };
}

function buildDirective(params: Readonly<{
    automations: ReadonlyArray<{
        automationId: string;
        expectedTemplateVersion: number;
        triggerDefinitionEnvelope?: string | null;
    }>;
    runs?: ReadonlyArray<ReturnType<typeof buildEncryptedRunMigrationItem>>;
}>) {
    const directive = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
        action: "migrate",
        templates: params.automations.map((automation) => ({
            automationId: automation.automationId,
            expectedTemplateVersion: automation.expectedTemplateVersion,
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_encrypted_v1",
                payloadCiphertext:
                    "replacement-encrypted-template-" + automation.automationId,
            }),
            ...(automation.triggerDefinitionEnvelope === undefined
                ? {}
                : { triggerDefinitionEnvelope: automation.triggerDefinitionEnvelope }),
        })),
        ...(params.runs === undefined ? {} : { runs: params.runs }),
    });
    if (directive.action !== "migrate") {
        throw new Error("Expected the migration fixture to parse as a migrate directive");
    }
    return directive;
}

async function createPlainPluginEventAutomation(params: Readonly<{
    accountId: string;
    automationId: string;
    enabled: boolean;
    deletedAt?: Date | null;
}>) {
    return await db.automation.create({
        data: {
            id: params.automationId,
            accountId: params.accountId,
            name: "Catalog revision migration " + params.automationId,
            enabled: params.enabled,
            deletedAt: params.deletedAt ?? null,
            triggerKind: "pluginEvent",
            triggerEventPluginId: "com.example.github",
            triggerEventLocalId: "repository-event",
            triggerSourceSelectorId: SOURCE_SELECTOR_ID,
            triggerSourceContractVersion: 1,
            triggerObservationTransport: "checkpointedPull",
            triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
                automationId: params.automationId,
                templateVersion: 1,
                triggerKind: "pluginEvent",
                mode: "plain",
            }),
            targetType: "new_session",
            templateCiphertext: buildPlainTemplate(
                "catalog revision migration " + params.automationId,
            ),
            templateVersion: 1,
        },
        select: { id: true, templateVersion: true },
    });
}

function buildPluginEventMigrationItem(params: Readonly<{
    id: string;
    templateVersion: number;
}>) {
    return {
        automationId: params.id,
        expectedTemplateVersion: params.templateVersion,
        triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
            automationId: params.id,
            templateVersion: params.templateVersion + 1,
            triggerKind: "pluginEvent",
            mode: "e2ee",
        }),
    };
}

function buildMigrationDirectiveForSeed(
    seeded: Awaited<ReturnType<typeof seedAutomationRuns>>,
) {
    return buildDirective({
        automations: [
            {
                automationId: seeded.eventAutomation.id,
                expectedTemplateVersion: seeded.eventAutomation.templateVersion,
                triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
                    automationId: seeded.eventAutomation.id,
                    templateVersion: seeded.eventAutomation.templateVersion + 1,
                    triggerKind: "pluginEvent",
                    mode: "e2ee",
                }),
            },
            {
                automationId: seeded.conversationAutomation.id,
                expectedTemplateVersion:
                    seeded.conversationAutomation.templateVersion,
            },
        ],
        runs: [
            buildEncryptedRunMigrationItem({
                runId: seeded.eventRun.id,
                expectedRunRevision: seeded.eventRun.revision,
                originKind: "pluginEvent",
                templateVersion: seeded.eventAutomation.templateVersion,
                retainsOccurrenceEvidence: true,
                resultEnvelope: seeded.eventRun.resultEnvelope,
                replyContextEnvelope: seeded.eventRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope:
                    seeded.eventRun.replyHandoffReceiptEnvelope,
            }),
            buildEncryptedRunMigrationItem({
                runId: seeded.conversationRun.id,
                expectedRunRevision: seeded.conversationRun.revision,
                originKind: "conversation",
                templateVersion: seeded.conversationAutomation.templateVersion,
                retainsOccurrenceEvidence: true,
                resultEnvelope: seeded.conversationRun.resultEnvelope,
                replyContextEnvelope: seeded.conversationRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope:
                    seeded.conversationRun.replyHandoffReceiptEnvelope,
            }),
            buildEncryptedRunMigrationItem({
                runId: seeded.scheduledRun.id,
                expectedRunRevision: seeded.scheduledRun.revision,
                originKind: "scheduled",
                templateVersion: seeded.eventAutomation.templateVersion,
                retainsOccurrenceEvidence: false,
                resultEnvelope: seeded.scheduledRun.resultEnvelope,
                replyContextEnvelope: seeded.scheduledRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope:
                    seeded.scheduledRun.replyHandoffReceiptEnvelope,
            }),
            buildEncryptedRunMigrationItem({
                runId: seeded.manualRun.id,
                expectedRunRevision: seeded.manualRun.revision,
                originKind: "manual",
                templateVersion: seeded.eventAutomation.templateVersion,
                retainsOccurrenceEvidence: false,
                resultEnvelope: seeded.manualRun.resultEnvelope,
                replyContextEnvelope: seeded.manualRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope:
                    seeded.manualRun.replyHandoffReceiptEnvelope,
            }),
        ],
    });
}

describe("Automation account-encryption Run migration directive", () => {
    it("uses a monotonic Run revision rather than a timestamp witness", () => {
        const baseRun = {
            runId: "run-1",
            triggerEvidenceEnvelope: JSON.stringify({
                t: "encrypted",
                c: "replacement-encrypted-evidence",
            }),
            occurrenceEvidenceEqualityTag: E2EE_TAG,
            executionInputEnvelope: null,
            resultEnvelope: null,
            replyContextEnvelope: null,
            replyHandoffReceiptEnvelope: null,
        };

        expect({
            revision: AccountEncryptionMigrateAutomationsDirectiveSchema.safeParse({
                action: "migrate",
                templates: [],
                runs: [{ ...baseRun, expectedRunRevision: 0 }],
            }).success,
            timestamp: AccountEncryptionMigrateAutomationsDirectiveSchema.safeParse({
                action: "migrate",
                templates: [],
                runs: [{ ...baseRun, expectedUpdatedAt: 0 }],
            }).success,
        }).toEqual({ revision: true, timestamp: false });
    });
});

describe("Automation account-encryption Run migration (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-account-encryption-runs-",
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("fails closed before clearing Automations for an inconsistent E2EE Account", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({
            data: {
                publicKey: binding.publicKey,
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Inconsistent Account migration",
                enabled: true,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildEncryptedTemplate("private-migration-template-sentinel"),
                templateVersion: 1,
            },
            select: { id: true },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "plain",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "invalid_content" });
        await expect(db.automation.findUnique({
            where: { id: automation.id },
            select: { id: true },
        })).resolves.toEqual({ id: automation.id });
    });

    it("atomically migrates every retained all-origin private envelope and converts a predecessor result", async () => {
        await assertAllOriginAutomationRunMigrationToE2ee();
    });

    it("advances the Event catalog revision exactly once when migration rewrites visible enabled Event definitions", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automationEventCatalogState.create({
            data: {
                accountId: account.id,
                eventSourceDefinitionsRevision: 17n,
            },
        });
        const first = await createPlainPluginEventAutomation({
            accountId: account.id,
            automationId: "automation-catalog-migrate-first",
            enabled: true,
        });
        const second = await createPlainPluginEventAutomation({
            accountId: account.id,
            automationId: "automation-catalog-migrate-second",
            enabled: true,
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: buildDirective({
                    automations: [
                        buildPluginEventMigrationItem(first),
                        buildPluginEventMigrationItem(second),
                    ],
                }),
            }),
        )).resolves.toEqual({ status: "applied" });

        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 18n });
    });

    it("advances the Event catalog revision exactly once when clear removes visible enabled Event definitions", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automationEventCatalogState.create({
            data: {
                accountId: account.id,
                eventSourceDefinitionsRevision: 23n,
            },
        });
        await createPlainPluginEventAutomation({
            accountId: account.id,
            automationId: "automation-catalog-clear-first",
            enabled: true,
        });
        await createPlainPluginEventAutomation({
            accountId: account.id,
            automationId: "automation-catalog-clear-second",
            enabled: true,
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "applied" });

        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 24n });
    });

    it("does not advance the Event catalog revision for invisible Event rows, schedule rows, or assert-empty", async () => {
        const migrationAccount = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automationEventCatalogState.create({
            data: {
                accountId: migrationAccount.id,
                eventSourceDefinitionsRevision: 31n,
            },
        });
        const disabledEvent = await createPlainPluginEventAutomation({
            accountId: migrationAccount.id,
            automationId: "automation-catalog-disabled-migrate",
            enabled: false,
        });
        const deletedEvent = await createPlainPluginEventAutomation({
            accountId: migrationAccount.id,
            automationId: "automation-catalog-deleted-migrate",
            enabled: true,
            deletedAt: new Date("2026-08-13T00:00:00.000Z"),
        });
        const schedule = await db.automation.create({
            data: {
                id: "automation-catalog-schedule-migrate",
                accountId: migrationAccount.id,
                name: "Catalog revision schedule migration",
                enabled: true,
                triggerKind: "schedule",
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildPlainTemplate("catalog revision schedule"),
                templateVersion: 1,
            },
            select: { id: true, templateVersion: true },
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: migrationAccount.id,
                toMode: "e2ee",
                directive: buildDirective({
                    automations: [
                        buildPluginEventMigrationItem(disabledEvent),
                        buildPluginEventMigrationItem(deletedEvent),
                        {
                            automationId: schedule.id,
                            expectedTemplateVersion: schedule.templateVersion,
                        },
                    ],
                }),
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: migrationAccount.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 31n });

        const clearAccount = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automationEventCatalogState.create({
            data: {
                accountId: clearAccount.id,
                eventSourceDefinitionsRevision: 37n,
            },
        });
        await createPlainPluginEventAutomation({
            accountId: clearAccount.id,
            automationId: "automation-catalog-disabled-clear",
            enabled: false,
        });
        await createPlainPluginEventAutomation({
            accountId: clearAccount.id,
            automationId: "automation-catalog-deleted-clear",
            enabled: true,
            deletedAt: new Date("2026-08-13T00:00:00.000Z"),
        });
        await db.automation.create({
            data: {
                id: "automation-catalog-schedule-clear",
                accountId: clearAccount.id,
                name: "Catalog revision schedule clear",
                enabled: true,
                triggerKind: "schedule",
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildPlainTemplate("catalog revision clear"),
                templateVersion: 1,
            },
        });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: clearAccount.id,
                toMode: "e2ee",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: clearAccount.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 37n });

        const emptyAccount = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automationEventCatalogState.create({
            data: {
                accountId: emptyAccount.id,
                eventSourceDefinitionsRevision: 41n,
            },
        });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: emptyAccount.id,
                toMode: "e2ee",
                directive: { action: "assert_empty" },
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: emptyAccount.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 41n });
    });

    it("rejects a retained V2 execution input on an Event Run before Account migration", async () => {
        const seeded = await seedAutomationRuns();
        const retainedV2EventInput = buildExecutionInput({
            templateCiphertext: seeded.eventAutomation.templateCiphertext,
            origin: { kind: "manual", invokedAt: 1_723_247_201_000 },
        });
        const sourceEventRun = await db.automationRun.update({
            where: { id: seeded.eventRun.id },
            data: { executionInputEnvelope: retainedV2EventInput },
            select: migrationRunContentSelect,
        });
        const directive = buildMigrationDirectiveForSeed({
            ...seeded,
            eventRun: sourceEventRun,
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: seeded.account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "invalid_content" });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.eventRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(sourceEventRun);
        await expect(db.account.findUniqueOrThrow({
            where: { id: seeded.account.id },
            select: { encryptionMode: true },
        })).resolves.toEqual({ encryptionMode: "plain" });
    });

    it("migrates one bound Event definition with its template in both directions and rekey, and leaves both untouched on invalid or stale targets", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const automationId = "automation-account-encryption-paired-definition";
        const sourceEnvelope = buildTriggerDefinitionEnvelope({
            automationId,
            templateVersion: 1,
            triggerKind: "pluginEvent",
            mode: "plain",
        });
        const automation = await db.automation.create({
            data: {
                id: automationId,
                accountId: account.id,
                name: "Paired trigger-definition migration",
                enabled: false,
                triggerKind: "pluginEvent",
                triggerEventPluginId: "com.example.github",
                triggerEventLocalId: "repository-event",
                triggerSourceSelectorId: SOURCE_SELECTOR_ID,
                triggerSourceContractVersion: 1,
                triggerObservationTransport: "checkpointedPull",
                triggerDefinitionEnvelope: sourceEnvelope,
                targetType: "new_session",
                templateCiphertext: buildPlainTemplate("paired definition source"),
                templateVersion: 1,
            },
            select: {
                id: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        });

        const encryptedTemplate = buildEncryptedTemplate("paired-encrypted-template");
        const encryptedEnvelope = buildTriggerDefinitionEnvelope({
            automationId: automation.id,
            templateVersion: automation.templateVersion + 1,
            triggerKind: "pluginEvent",
            mode: "e2ee",
        });
        const missingDefinitionTarget = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
            action: "migrate",
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: automation.templateVersion,
                templateCiphertext: encryptedTemplate,
            }],
        });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: missingDefinitionTarget,
            }),
        )).resolves.toEqual({ status: "migration_incomplete" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
                triggerDefinitionEnvelope: true,
            },
        })).resolves.toEqual({
            templateCiphertext: automation.templateCiphertext,
            templateVersion: automation.templateVersion,
            triggerDefinitionEnvelope: sourceEnvelope,
        });
        const invalidTarget = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
            action: "migrate",
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: automation.templateVersion,
                templateCiphertext: encryptedTemplate,
                triggerDefinitionEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "wrong-purpose-definition-target",
                }),
            }],
        });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: invalidTarget,
            }),
        )).resolves.toEqual({ status: "invalid_content" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
                triggerDefinitionEnvelope: true,
            },
        })).resolves.toEqual({
            templateCiphertext: automation.templateCiphertext,
            templateVersion: automation.templateVersion,
            triggerDefinitionEnvelope: sourceEnvelope,
        });

        const toEncrypted = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
            action: "migrate",
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: automation.templateVersion,
                templateCiphertext: encryptedTemplate,
                triggerDefinitionEnvelope: encryptedEnvelope,
            }],
        });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: toEncrypted,
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
                triggerDefinitionEnvelope: true,
            },
        })).resolves.toEqual({
            templateCiphertext: encryptedTemplate,
            templateVersion: 2,
            triggerDefinitionEnvelope: encryptedEnvelope,
        });

        await db.account.update({
            where: { id: account.id },
            data: {
                encryptionMode: "e2ee",
                ...createSignedAccountContentBinding(),
            },
        });
        const rekeyTemplate = buildEncryptedTemplate("paired-rekey-template");
        const rekeyEnvelope = buildTriggerDefinitionEnvelope({
            automationId: automation.id,
            templateVersion: 3,
            triggerKind: "pluginEvent",
            mode: "e2ee",
        });
        const rekey = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
            action: "migrate",
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: 2,
                templateCiphertext: rekeyTemplate,
                triggerDefinitionEnvelope: rekeyEnvelope,
            }],
        });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: rekey,
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
                triggerDefinitionEnvelope: true,
            },
        })).resolves.toEqual({
            templateCiphertext: rekeyTemplate,
            templateVersion: 3,
            triggerDefinitionEnvelope: rekeyEnvelope,
        });
        const plainTemplate = buildPlainTemplate("paired plain target");
        const plainEnvelope = buildTriggerDefinitionEnvelope({
            automationId: automation.id,
            templateVersion: 4,
            triggerKind: "pluginEvent",
            mode: "plain",
        });
        const toPlain = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
            action: "migrate",
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: 3,
                templateCiphertext: plainTemplate,
                triggerDefinitionEnvelope: plainEnvelope,
            }],
        });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "plain",
                directive: toPlain,
            }),
        )).resolves.toEqual({ status: "applied" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
                triggerDefinitionEnvelope: true,
            },
        })).resolves.toEqual({
            templateCiphertext: plainTemplate,
            templateVersion: 4,
            triggerDefinitionEnvelope: plainEnvelope,
        });

        await db.automation.update({
            where: { id: automation.id },
            data: { templateVersion: 5 },
        });
        const staleTarget = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
            action: "migrate",
            templates: [{
                automationId: automation.id,
                expectedTemplateVersion: 4,
                templateCiphertext: encryptedTemplate,
                triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
                    automationId: automation.id,
                    templateVersion: 5,
                    triggerKind: "pluginEvent",
                    mode: "e2ee",
                }),
            }],
        });
        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive: staleTarget,
            }),
        )).rejects.toBeInstanceOf(AutomationAccountEncryptionMigrationConflictError);
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
                triggerDefinitionEnvelope: true,
            },
        })).resolves.toEqual({
            templateCiphertext: plainTemplate,
            templateVersion: 5,
            triggerDefinitionEnvelope: plainEnvelope,
        });
    });

    it("rejects an exact migration replay after a canonical heartbeat advances a migrated Run revision", async () => {
        const seeded = await seedAutomationRuns();
        const directive = buildMigrationDirectiveForSeed(seeded);

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: seeded.account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "applied" });

        const nextAccountBinding = createSignedAccountContentBinding();
        const verifiedNextAccountBinding = verifyAccountContentKeyBindingForAccountPublicKey({
            accountPublicKeyHex: nextAccountBinding.publicKey,
            contentPublicKey: nextAccountBinding.contentPublicKey,
            contentPublicKeySignature: nextAccountBinding.contentPublicKeySig,
        });
        if (!verifiedNextAccountBinding) {
            throw new Error("Expected a valid Account content-key binding");
        }
        await inTx(async (tx) => {
            const account = await tx.account.findUniqueOrThrow({
                where: { id: seeded.account.id },
                select: { seq: true },
            });
            await applyAccountEncryptionTransitionInTx(tx, {
                accountId: seeded.account.id,
                expectedVersion: account.seq,
                toMode: "e2ee",
                accountPublicKeyHex: nextAccountBinding.publicKey,
                contentKey: {
                    kind: "migration_replace",
                    binding: verifiedNextAccountBinding,
                },
            });
        });

        await db.automation.update({
            where: { id: seeded.eventAutomation.id },
            data: { enabled: true },
        });
        await db.automationAssignment.create({
            data: {
                automationId: seeded.eventAutomation.id,
                machineId: "machine-account-encryption-migration",
                enabled: true,
            },
        });
        await db.automationRun.update({
            where: { id: seeded.eventRun.id },
            data: { dueAt: new Date(0) },
        });

        const claim = await claimAutomationRun({
            accountId: seeded.account.id,
            machineId: "machine-account-encryption-migration",
            leaseDurationMs: 30_000,
            expectedTriggerKind: "pluginEvent",
        });
        expect(claim.run?.id).toBe(seeded.eventRun.id);
        if (!claim.run) throw new Error("Expected the migrated Event Run to be claimed");

        await expect(heartbeatAutomationRun({
            accountId: seeded.account.id,
            runId: claim.run.id,
            machineId: "machine-account-encryption-migration",
            attempt: claim.run.attempt,
            leaseDurationMs: 30_000,
            expectedTriggerKind: "pluginEvent",
        })).resolves.toEqual({
            ok: true,
            leaseExpiresAt: expect.any(Date),
        });

        await expect(inTx(async (tx) =>
            await matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: seeded.account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "mismatch" });
    });

    it("rejects one invalid retained reply receipt before any Run envelope or template changes", async () => {
        const seeded = await seedAutomationRuns();
        const directive = buildMigrationDirectiveForSeed(seeded);
        const invalidDirective = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
            ...directive,
            runs: directive.runs!.map((run, index) => index === 1
                ? {
                    ...run,
                    replyHandoffReceiptEnvelope: JSON.stringify({
                        t: "plain",
                        v: { invalid: "wrong target Account mode" },
                    }),
                }
                : run),
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: seeded.account.id,
                toMode: "e2ee",
                directive: invalidDirective,
            }),
        )).resolves.toEqual({ status: "invalid_content" });

        await expect(db.automation.findUniqueOrThrow({
            where: { id: seeded.eventAutomation.id },
            select: { templateCiphertext: true, templateVersion: true },
        })).resolves.toEqual({
            templateCiphertext: seeded.eventAutomation.templateCiphertext,
            templateVersion: seeded.eventAutomation.templateVersion,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.eventRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(seeded.eventRun);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.conversationRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(seeded.conversationRun);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.scheduledRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(seeded.scheduledRun);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.manualRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(seeded.manualRun);
    });

    it("rejects a schedule Run candidate that carries trigger evidence instead of the required null pair", async () => {
        const seeded = await seedAutomationRuns();
        const directive = buildMigrationDirectiveForSeed(seeded);
        const invalidDirective = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
            ...directive,
            runs: directive.runs!.map((run) => run.runId === seeded.scheduledRun.id
                ? {
                    ...run,
                    triggerEvidenceEnvelope: JSON.stringify({
                        t: "encrypted",
                        c: "schedule-runs-must-not-carry-trigger-evidence",
                    }),
                    occurrenceEvidenceEqualityTag: E2EE_TAG,
                }
                : run),
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: seeded.account.id,
                toMode: "e2ee",
                directive: invalidDirective,
            }),
        )).resolves.toEqual({ status: "invalid_content" });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.eventRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(seeded.eventRun);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.conversationRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(seeded.conversationRun);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.scheduledRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(seeded.scheduledRun);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.manualRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(seeded.manualRun);
    });

    it("refuses an older signed migration inventory that omits any retained all-origin Run", async () => {
        const seeded = await seedAutomationRuns();
        const directive = buildDirective({
            automations: [
                {
                    automationId: seeded.eventAutomation.id,
                    expectedTemplateVersion:
                        seeded.eventAutomation.templateVersion,
                },
                {
                    automationId: seeded.conversationAutomation.id,
                    expectedTemplateVersion:
                        seeded.conversationAutomation.templateVersion,
                },
            ],
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: seeded.account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "migration_incomplete" });

        await expect(db.automation.findUniqueOrThrow({
            where: { id: seeded.eventAutomation.id },
            select: { templateCiphertext: true, templateVersion: true },
        })).resolves.toEqual({
            templateCiphertext: seeded.eventAutomation.templateCiphertext,
            templateVersion: seeded.eventAutomation.templateVersion,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.eventRun.id },
            select: migrationRunContentSelect,
        })).resolves.toEqual(seeded.eventRun);
    });

    it("rejects a retained Run inventory larger than the signed request transport bound without mutation", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true, encryptionMode: true },
        });
        const automation = await db.automation.create({
            data: {
                id: "automation-account-encryption-too-large",
                accountId: account.id,
                name: "Oversized retained Run inventory",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildPlainTemplate("oversized migration"),
                templateVersion: 1,
            },
            select: {
                id: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        });
        await db.automationRun.createMany({
            data: Array.from({
                length: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS + 1,
            }, (_, index) => ({
                id: `run-account-encryption-too-large-${index}`,
                automationId: automation.id,
                accountId: account.id,
                state: "queued" as const,
                originKind: "scheduled" as const,
                executionInputEnvelope: buildExecutionInput({
                    templateCiphertext: automation.templateCiphertext,
                    origin: { kind: "scheduled", scheduledFor: index },
                }),
                scheduledAt: new Date(index),
                dueAt: new Date(index),
            })),
        });
        const directive = buildDirective({
            automations: [{
                automationId: automation.id,
                expectedTemplateVersion: automation.templateVersion,
            }],
            runs: [],
        });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: account.id,
                toMode: "e2ee",
                directive,
            }),
        )).resolves.toEqual({ status: "migration_too_large" });

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true },
        })).resolves.toEqual({ encryptionMode: account.encryptionMode });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: { templateCiphertext: true, templateVersion: true },
        })).resolves.toEqual({
            templateCiphertext: automation.templateCiphertext,
            templateVersion: automation.templateVersion,
        });
        await expect(db.automationRun.count({
            where: { accountId: account.id },
        })).resolves.toBe(
            ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS + 1,
        );
    });

    it("pages more than 500 current retained Runs and reapplies exact Event and Conversation evidence witnesses", async () => {
        const account = await db.account.create({
            data: {
                id: "account-encryption-transition-current-pages",
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const eventAutomation = await db.automation.create({
            data: {
                id: "automation-encryption-transition-current-pages-event",
                accountId: account.id,
                name: "Current Event source page",
                enabled: false,
                triggerKind: "pluginEvent",
                triggerEventPluginId: "com.example.github",
                triggerEventLocalId: "repository-event",
                triggerSourceSelectorId: SOURCE_SELECTOR_ID,
                triggerSourceContractVersion: 1,
                triggerObservationTransport: "checkpointedPull",
                triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
                    automationId: "automation-encryption-transition-current-pages-event",
                    templateVersion: 1,
                    triggerKind: "pluginEvent",
                    mode: "e2ee",
                }),
                targetType: "new_session",
                templateCiphertext: buildEncryptedTemplate("current-page-event-template"),
                templateVersion: 1,
            },
            select: { id: true },
        });
        const conversationAutomation = await db.automation.create({
            data: {
                id: "automation-encryption-transition-current-pages-conversation",
                accountId: account.id,
                name: "Current Conversation source page",
                enabled: false,
                // The retained Conversation Run witnesses use this scheduled definition.
                triggerKind: "schedule",
                scheduleKind: "interval",
                everyMs: 60_000,
                triggerDefinitionEnvelope: null,
                targetType: "new_session",
                templateCiphertext: buildEncryptedTemplate("current-page-conversation-template"),
                templateVersion: 1,
            },
            select: { id: true },
        });
        const occurredAt = new Date("2026-08-12T00:00:00.000Z");
        const eventEvidence = JSON.stringify({
            t: "encrypted",
            c: "exact-event-evidence-witness-bytes",
        });
        const conversationEvidence = JSON.stringify({
            t: "encrypted",
            c: "exact-conversation-evidence-witness-bytes",
        });
        // A SHA-256 base64url tag's final sextet has four significant bits.
        // Keep this witness distinct from E2EE_TAG while retaining canonical
        // base64url encoding.
        const conversationTag = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
        await db.automationRun.createMany({
            data: [
                ...Array.from({ length: 499 }, (_, index) => ({
                    id: `run-current-page-event-${String(index).padStart(3, "0")}`,
                    accountId: account.id,
                    automationId: eventAutomation.id,
                    state: "queued" as const,
                    originKind: "pluginEvent" as const,
                    originOccurredAt: new Date(occurredAt.getTime() + index),
                    occurrenceKey: `current-page-event-${index}`,
                    occurrenceEvidenceEqualityTag: E2EE_TAG,
                    originSourceSelectorId: SOURCE_SELECTOR_ID,
                    triggerEvidenceEnvelope: JSON.stringify({
                        t: "encrypted",
                        c: `current-page-event-evidence-${index}`,
                    }),
                    scheduledAt: occurredAt,
                    dueAt: occurredAt,
                })),
                {
                    id: "run-current-page-event-witness",
                    accountId: account.id,
                    automationId: eventAutomation.id,
                    state: "queued" as const,
                    originKind: "pluginEvent" as const,
                    originOccurredAt: occurredAt,
                    occurrenceKey: "current-page-event-witness",
                    occurrenceEvidenceEqualityTag: E2EE_TAG,
                    originSourceSelectorId: SOURCE_SELECTOR_ID,
                    triggerEvidenceEnvelope: eventEvidence,
                    scheduledAt: occurredAt,
                    dueAt: occurredAt,
                },
                {
                    id: "run-current-page-conversation-witness",
                    accountId: account.id,
                    automationId: conversationAutomation.id,
                    state: "queued" as const,
                    originKind: "conversation" as const,
                    originOccurredAt: occurredAt,
                    occurrenceKey: "current-page-conversation-witness",
                    occurrenceEvidenceEqualityTag: conversationTag,
                    triggerEvidenceEnvelope: conversationEvidence,
                    scheduledAt: occurredAt,
                    dueAt: occurredAt,
                },
            ],
        });

        const first = await inTx(async (tx) => (
            await inspectAutomationAccountEncryptionTransitionInTx({
                tx,
                accountId: account.id,
                sourceMode: "e2ee",
            })
        ));
        expect(first.status).toBe("complete");
        if (first.status !== "complete" || !first.page.nextCursor) {
            throw new Error("Expected the first retained Run source page to continue");
        }
        expect(first.page.runCount).toBe(498);
        expect(first.page.nextCursor.kind).toBe("run");

        const second = await inTx(async (tx) => (
            await inspectAutomationAccountEncryptionTransitionInTx({
                tx,
                accountId: account.id,
                sourceMode: "e2ee",
                cursor: first.page.nextCursor,
            })
        ));
        expect(second.status).toBe("complete");
        if (second.status !== "complete") {
            throw new Error("Expected the second retained Run source page to complete");
        }
        expect(second.page.runCount).toBe(3);
        expect(second.page.nextCursor).toBeUndefined();

        const currentRuns = [
            ...first.page.items,
            ...second.page.items,
        ].filter((item) => item.kind === "run");
        expect(currentRuns).toHaveLength(501);
        const eventWitness = currentRuns.find(
            (item) => item.runId === "run-current-page-event-witness",
        );
        const conversationWitness = currentRuns.find(
            (item) => item.runId === "run-current-page-conversation-witness",
        );
        if (!eventWitness || !conversationWitness) {
            throw new Error("Expected both retained Event and Conversation witnesses");
        }
        expect(eventWitness.source).toMatchObject({
            triggerEvidenceEnvelope: eventEvidence,
            occurrenceEvidenceEqualityTag: E2EE_TAG,
        });
        expect(conversationWitness.source).toMatchObject({
            triggerEvidenceEnvelope: conversationEvidence,
            occurrenceEvidenceEqualityTag: conversationTag,
        });
        const stageItems = [eventWitness, conversationWitness].map((item) => ({
            kind: "run" as const,
            runId: item.runId,
            automationId: item.automationId,
            expectedRevision: item.revision,
            originKind: item.originKind,
            occurrenceKey: item.occurrenceKey,
            source: item.source,
            target: {
                triggerEvidenceEnvelope: item.source.triggerEvidenceEnvelope,
                occurrenceEvidenceEqualityTag:
                    item.source.occurrenceEvidenceEqualityTag,
                executionInputEnvelope: item.source.executionInputEnvelope,
                resultEnvelope: item.source.resultEnvelope,
                replyContextEnvelope: item.source.replyContextEnvelope,
                replyHandoffReceiptEnvelope:
                    item.source.replyHandoffReceiptEnvelope,
            },
        }));
        await expect(inTx(async (tx) => (
            await validateAutomationAccountEncryptionTransitionStageInTx({
                tx,
                accountId: account.id,
                fromMode: "e2ee",
                toMode: "e2ee",
                items: stageItems,
            })
        ))).resolves.toEqual({ status: "validated" });
        await expect(inTx(async (tx) => (
            await applyAutomationAccountEncryptionTransitionStageInTx({
                tx,
                accountId: account.id,
                fromMode: "e2ee",
                toMode: "e2ee",
                items: stageItems,
            })
        ))).resolves.toEqual({ status: "applied" });
        const retainedWitnesses = await db.automationRun.findMany({
            where: { id: { in: stageItems.map((item) => item.runId) } },
            orderBy: { id: "asc" },
            select: {
                id: true,
                triggerEvidenceEnvelope: true,
                occurrenceEvidenceEqualityTag: true,
            },
        });
        expect(retainedWitnesses).toEqual([
            {
                id: "run-current-page-conversation-witness",
                triggerEvidenceEnvelope: conversationEvidence,
                occurrenceEvidenceEqualityTag: conversationTag,
            },
            {
                id: "run-current-page-event-witness",
                triggerEvidenceEnvelope: eventEvidence,
                occurrenceEvidenceEqualityTag: E2EE_TAG,
            },
        ]);
    });

    it("skips more than one legacy page of compacted schedule history while retaining Event rejoin evidence in the staged census", async () => {
        const account = await db.account.create({
            data: {
                id: "account-encryption-transition-compacted-history",
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const scheduleAutomation = await db.automation.create({
            data: {
                id: "automation-encryption-transition-compacted-history",
                accountId: account.id,
                name: "Compacted history source",
                enabled: false,
                triggerKind: "schedule",
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildEncryptedTemplate("compacted-history-template"),
                templateVersion: 1,
            },
            select: { id: true },
        });
        const eventAutomation = await db.automation.create({
            data: {
                id: "automation-encryption-transition-retained-event",
                accountId: account.id,
                name: "Retained Event evidence source",
                enabled: false,
                triggerKind: "pluginEvent",
                triggerEventPluginId: "com.example.github",
                triggerEventLocalId: "repository-event",
                triggerSourceSelectorId: SOURCE_SELECTOR_ID,
                triggerSourceContractVersion: 1,
                triggerObservationTransport: "checkpointedPull",
                triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
                    automationId: "automation-encryption-transition-retained-event",
                    templateVersion: 1,
                    triggerKind: "pluginEvent",
                    mode: "e2ee",
                }),
                targetType: "new_session",
                templateCiphertext: buildEncryptedTemplate("retained-event-template"),
                templateVersion: 1,
            },
            select: { id: true },
        });
        const compactedAt = new Date("2026-08-12T00:00:00.000Z");
        await db.automationRun.createMany({
            data: Array.from({ length: 501 }, (_, index) => ({
                id: `run-encryption-transition-compacted-${index}`,
                accountId: account.id,
                automationId: scheduleAutomation.id,
                state: "succeeded" as const,
                originKind: "scheduled" as const,
                scheduledAt: new Date(1_724_000_000_000 + index),
                dueAt: new Date(1_724_000_000_000 + index),
                finishedAt: new Date(1_724_000_000_000 + index),
                contentRemovedAt: compactedAt,
            })),
        });
        const retainedRun = await db.automationRun.create({
            data: {
                id: "run-encryption-transition-retained-event",
                accountId: account.id,
                automationId: eventAutomation.id,
                state: "succeeded",
                originKind: "pluginEvent",
                originOccurredAt: compactedAt,
                occurrenceKey: "retained-event-occurrence",
                occurrenceEvidenceEqualityTag: E2EE_TAG,
                originSourceSelectorId: SOURCE_SELECTOR_ID,
                triggerEvidenceEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "retained-event-evidence",
                }),
                scheduledAt: compactedAt,
                dueAt: compactedAt,
                finishedAt: compactedAt,
            },
            select: { id: true },
        });

        const inspected = await inTx(async (tx) => (
            await inspectAutomationAccountEncryptionTransitionInTx({
                tx,
                accountId: account.id,
                sourceMode: "e2ee",
            })
        ));
        expect(inspected.status).toBe("complete");
        if (inspected.status !== "complete") {
            throw new Error("Expected compacted-history transition inventory to be complete");
        }
        expect(inspected.page.runCount).toBe(1);
        expect(inspected.page.items.filter((item) => item.kind === "run"))
            .toEqual([expect.objectContaining({ runId: retainedRun.id })]);
        expect(inspected.page.nextCursor).toBeUndefined();

        const retainedInventory = inspected.page.items.find(
            (item) => item.kind === "run",
        );
        if (!retainedInventory || retainedInventory.kind !== "run") {
            throw new Error("Expected retained Event evidence in the staged inventory");
        }
        const target = {
            triggerEvidenceEnvelope: retainedInventory.source.triggerEvidenceEnvelope,
            occurrenceEvidenceEqualityTag:
                retainedInventory.source.occurrenceEvidenceEqualityTag,
            executionInputEnvelope: retainedInventory.source.executionInputEnvelope,
            resultEnvelope: retainedInventory.source.resultEnvelope,
            replyContextEnvelope: retainedInventory.source.replyContextEnvelope,
            replyHandoffReceiptEnvelope:
                retainedInventory.source.replyHandoffReceiptEnvelope,
        };
        await expect(inTx(async (tx) => (
            await validateAutomationAccountEncryptionTransitionStageInTx({
                tx,
                accountId: account.id,
                fromMode: "e2ee",
                toMode: "e2ee",
                items: [{
                    kind: "run",
                    runId: retainedInventory.runId,
                    automationId: retainedInventory.automationId,
                    expectedRevision: retainedInventory.revision,
                    originKind: retainedInventory.originKind,
                    occurrenceKey: retainedInventory.occurrenceKey,
                    source: {
                        ...retainedInventory.source,
                        occurrenceEvidenceEqualityTag:
                            "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                    },
                    target,
                }],
            })
        ))).resolves.toEqual({ status: "migration_incomplete" });
    });

    it("rejects a migration after canonical cancellation advances the Run revision", async () => {
        const seeded = await seedAutomationRuns();
        const directive = buildMigrationDirectiveForSeed(seeded);

        await expect(cancelAutomationRun({
            accountId: seeded.account.id,
            runId: seeded.eventRun.id,
        })).resolves.toMatchObject({
            id: seeded.eventRun.id,
            state: "cancelled",
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.eventRun.id },
            select: { revision: true },
        })).resolves.toEqual({ revision: seeded.eventRun.revision + 1 });

        await expect(inTx(async (tx) =>
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: seeded.account.id,
                toMode: "e2ee",
                directive,
            }),
        )).rejects.toBeInstanceOf(AutomationAccountEncryptionMigrationConflictError);

        await expect(db.automation.findUniqueOrThrow({
            where: { id: seeded.eventAutomation.id },
            select: { templateCiphertext: true, templateVersion: true },
        })).resolves.toEqual({
            templateCiphertext: seeded.eventAutomation.templateCiphertext,
            templateVersion: seeded.eventAutomation.templateVersion,
        });
    });
});
