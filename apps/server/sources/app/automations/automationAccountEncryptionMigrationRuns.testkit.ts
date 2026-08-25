import {
    AccountEncryptionMigrateAutomationsDirectiveSchema,
    deriveAutomationOccurrenceKeyV1,
    AutomationSourceSelectorIdV1Schema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";
import { expect } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

import {
    matchAutomationAccountEncryptionMigrationPostStateInTx,
    migrateAutomationAccountEncryptionInTx,
} from "./automationCrudService";

const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
    "8a2e26d2-5b2b-4e9b-a57f-68ca5e575dc7",
);
const e2eeTag = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const triggerDefinitionMaterial = {
    type: "dataKey" as const,
    machineKey: new Uint8Array(32).fill(9),
};

const runContentSelect = {
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

function eventTriggerDefinitionEnvelope(params: Readonly<{
    automationId: string;
    templateVersion: number;
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
        sourceSelectorId,
    };
    const definition = {
        v: 1,
        sourceInstanceId: "migration-repository",
        sourceConfig: { repositoryId: 42 },
        displayLabel: "Migration repository",
        filter: null,
        maximumObservationAgeMs: null,
    };
    return JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "plain",
        binding,
        definition,
    }));
}

function eventEvidence() {
    return {
        v: 1 as const,
        kind: "pluginEvent" as const,
        eventRef: {
            pluginId: "com.example.github",
            localId: "repository-event",
        },
        sourceSelectorId,
        occurrenceId: "migration-event-1",
        occurredAt: 1_724_000_000_000,
        payload: { action: "opened", repository: { id: 42 } },
    };
}

function conversationEvidence() {
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

function plainTemplate(prompt: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_plain_v1",
        payload: { prompt },
    });
}

function encryptedTemplate(ciphertext: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: ciphertext,
    });
}

function strictExecutionInput(params: Readonly<{
    templateVersion: number;
    prompt: string;
    evidence: unknown;
}>): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: params.templateVersion,
        template: { t: "plain", v: { v: 1, prompt: params.prompt } },
        triggerEvidence: { t: "plain", v: params.evidence },
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: {
                    serverId: "server-account-encryption-migration",
                    machineId: "machine-account-encryption-migration",
                },
                directory: "/tmp/account-encryption-migration",
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
    if (serialized.kind !== "available") {
        throw new Error("All-origin migration fixture must use a strict Run recipe");
    }
    return serialized.serialized;
}

function encryptedStrictExecutionInput(params: Readonly<{
    runId: string;
    templateVersion: number;
}>): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
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
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: {
                    serverId: "server-account-encryption-migration",
                    machineId: "machine-account-encryption-migration",
                },
                directory: "/tmp/account-encryption-migration",
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
    if (serialized.kind !== "available") {
        throw new Error("All-origin migration fixture must use a strict encrypted Run recipe");
    }
    return serialized.serialized;
}

function executionInput(params: Readonly<{
    templateCiphertext: string;
    origin: Readonly<{ kind: "scheduled"; scheduledFor: number }>
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

function plainResultEnvelope(params: Readonly<{
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

function plainReplyContextEnvelope(params: Readonly<{
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

function plainReplyReceiptEnvelope(params: Readonly<{
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

async function seedAllOriginRuns(onAccountCreated?: (accountId: string) => void) {
    const account = await db.account.create({
        data: { encryptionMode: "plain" },
        select: { id: true },
    });
    onAccountCreated?.(account.id);
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
            triggerSourceSelectorId: sourceSelectorId,
            triggerSourceContractVersion: 1,
            triggerObservationTransport: "checkpointedPull",
            triggerDefinitionEnvelope: eventTriggerDefinitionEnvelope({
                automationId: eventAutomationId,
                templateVersion: 4,
            }),
            targetType: "new_session",
            templateCiphertext: plainTemplate("migrate Event Run"),
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
            // Conversation is the Run origin below; this Automation keeps a
            // normal schedule definition so Channel admission is an additive
            // invocation source rather than a definition trigger.
            triggerKind: "schedule",
            scheduleKind: "interval",
            everyMs: 60_000,
            targetType: "new_session",
            templateCiphertext: plainTemplate("migrate Conversation Run"),
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
    const event = eventEvidence();
    const eventRunId = "run-account-encryption-event";
    const eventRun = await db.automationRun.create({
        data: {
            id: eventRunId,
            automationId: eventAutomation.id,
            accountId: account.id,
            state: "queued",
            originKind: "pluginEvent",
            originOccurredAt: new Date(event.occurredAt),
            occurrenceKey: deriveAutomationOccurrenceKeyV1(event),
            occurrenceEvidenceEqualityTag: null,
            originSourceSelectorId: sourceSelectorId,
            triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: event }),
            executionInputEnvelope: strictExecutionInput({
                templateVersion: eventAutomation.templateVersion,
                prompt: "migrate Event Run",
                evidence: event,
            }),
            resultEnvelope: plainResultEnvelope({
                accountId: account.id,
                automationId: eventAutomation.id,
                runId: eventRunId,
                handoffId: "handoff-account-encryption-event",
            }),
            scheduledAt: new Date("2026-08-10T10:00:00.000Z"),
            dueAt: new Date("2026-08-10T10:00:00.000Z"),
        },
        select: runContentSelect,
    });
    const conversation = conversationEvidence();
    const conversationRunId = "run-account-encryption-conversation";
    const conversationCorrespondence = {
        accountId: account.id,
        automationId: conversationAutomation.id,
        runId: conversationRunId,
        handoffId: "handoff-account-encryption-conversation",
    };
    const conversationOccurrenceKey = deriveAutomationOccurrenceKeyV1(conversation);
    const conversationRun = await db.automationRun.create({
        data: {
            id: conversationRunId,
            automationId: conversationAutomation.id,
            accountId: account.id,
            state: "succeeded",
            originKind: "conversation",
            originOccurredAt: new Date(conversation.occurredAt),
            occurrenceKey: conversationOccurrenceKey,
            occurrenceEvidenceEqualityTag: null,
            triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: conversation }),
            executionInputEnvelope: strictExecutionInput({
                templateVersion: conversationAutomation.templateVersion,
                prompt: "migrate Conversation Run",
                evidence: conversation,
            }),
            resultEnvelope: plainResultEnvelope(conversationCorrespondence),
            replyContextEnvelope: plainReplyContextEnvelope(
                {
                    automationId: conversationCorrespondence.automationId,
                    occurrenceKey: conversationOccurrenceKey,
                },
                conversationAutomation.templateVersion,
            ),
            replyHandoffActionPluginId: "happier.channels",
            replyHandoffActionLocalId: "automation/result-deliver-v1",
            replyHandoffTargetMachineId: replyMachine.id,
            replyHandoffTargetMachineInstallationId: "installation-account-encryption-migration",
            replyHandoffTargetMaterializationId: "materialization-account-encryption-migration",
            replyHandoffId: conversationCorrespondence.handoffId,
            replyHandoffState: "accepted",
            replyHandoffReceiptEnvelope: plainReplyReceiptEnvelope(conversationCorrespondence),
            scheduledAt: new Date("2026-08-10T10:01:00.000Z"),
            dueAt: new Date("2026-08-10T10:01:00.000Z"),
            finishedAt: new Date("2026-08-10T10:02:00.000Z"),
        },
        select: runContentSelect,
    });
    const scheduledRun = await db.automationRun.create({
        data: {
            id: "run-account-encryption-scheduled",
            automationId: eventAutomation.id,
            accountId: account.id,
            state: "queued",
            originKind: "scheduled",
            originOccurredAt: null,
            executionInputEnvelope: executionInput({
                templateCiphertext: eventAutomation.templateCiphertext,
                origin: {
                    kind: "scheduled",
                    scheduledFor: new Date("2026-08-10T10:03:00.000Z").getTime(),
                },
            }),
            scheduledAt: new Date("2026-08-10T10:03:00.000Z"),
            dueAt: new Date("2026-08-10T10:03:00.000Z"),
        },
        select: runContentSelect,
    });
    const manualRun = await db.automationRun.create({
        data: {
            id: "run-account-encryption-manual",
            automationId: eventAutomation.id,
            accountId: account.id,
            state: "succeeded",
            originKind: "manual",
            originOccurredAt: null,
            executionInputEnvelope: executionInput({
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
        select: runContentSelect,
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

function migrationItem(params: Readonly<{
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
        occurrenceEvidenceEqualityTag: params.retainsOccurrenceEvidence ? e2eeTag : null,
        executionInputEnvelope:
            params.originKind === "pluginEvent" || params.originKind === "conversation"
                ? encryptedStrictExecutionInput({
                    runId: params.runId,
                    templateVersion: params.templateVersion,
                })
                : executionInput({
                    templateCiphertext: encryptedTemplate(
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

function buildDirective(seeded: Awaited<ReturnType<typeof seedAllOriginRuns>>) {
    const directive = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
        action: "migrate",
        templates: [
            {
                automationId: seeded.eventAutomation.id,
                expectedTemplateVersion: seeded.eventAutomation.templateVersion,
                templateCiphertext: encryptedTemplate(
                    "replacement-encrypted-template-" + seeded.eventAutomation.id,
                ),
                triggerDefinitionEnvelope: JSON.stringify(
                    sealAutomationTriggerDefinitionStoredEnvelopeV1({
                        mode: "e2ee",
                        binding: {
                            v: 1,
                            automationId: seeded.eventAutomation.id,
                            templateVersion: seeded.eventAutomation.templateVersion + 1,
                            triggerKind: "pluginEvent",
                            eventRef: {
                                pluginId: "com.example.github",
                                localId: "repository-event",
                            },
                            sourceSelectorId,
                        },
                        definition: {
                            v: 1,
                            sourceInstanceId: "migration-repository",
                            sourceConfig: { repositoryId: 42 },
                            displayLabel: "Migration repository",
                            filter: null,
                            maximumObservationAgeMs: null,
                        },
                        material: triggerDefinitionMaterial,
                        randomBytes: (length) => new Uint8Array(length).fill(6),
                    }),
                ),
            },
            {
                automationId: seeded.conversationAutomation.id,
                expectedTemplateVersion: seeded.conversationAutomation.templateVersion,
                templateCiphertext: encryptedTemplate(
                    "replacement-encrypted-template-" + seeded.conversationAutomation.id,
                ),
            },
        ],
        runs: [
            migrationItem({
                runId: seeded.eventRun.id,
                expectedRunRevision: seeded.eventRun.revision,
                originKind: "pluginEvent",
                templateVersion: seeded.eventAutomation.templateVersion,
                retainsOccurrenceEvidence: true,
                resultEnvelope: seeded.eventRun.resultEnvelope,
                replyContextEnvelope: seeded.eventRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope: seeded.eventRun.replyHandoffReceiptEnvelope,
            }),
            migrationItem({
                runId: seeded.conversationRun.id,
                expectedRunRevision: seeded.conversationRun.revision,
                originKind: "conversation",
                templateVersion: seeded.conversationAutomation.templateVersion,
                retainsOccurrenceEvidence: true,
                resultEnvelope: seeded.conversationRun.resultEnvelope,
                replyContextEnvelope: seeded.conversationRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope: seeded.conversationRun.replyHandoffReceiptEnvelope,
            }),
            migrationItem({
                runId: seeded.scheduledRun.id,
                expectedRunRevision: seeded.scheduledRun.revision,
                originKind: "scheduled",
                templateVersion: seeded.eventAutomation.templateVersion,
                retainsOccurrenceEvidence: false,
                resultEnvelope: seeded.scheduledRun.resultEnvelope,
                replyContextEnvelope: seeded.scheduledRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope: seeded.scheduledRun.replyHandoffReceiptEnvelope,
            }),
            migrationItem({
                runId: seeded.manualRun.id,
                expectedRunRevision: seeded.manualRun.revision,
                originKind: "manual",
                templateVersion: seeded.eventAutomation.templateVersion,
                retainsOccurrenceEvidence: false,
                resultEnvelope: seeded.manualRun.resultEnvelope,
                replyContextEnvelope: seeded.manualRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope: seeded.manualRun.replyHandoffReceiptEnvelope,
            }),
        ],
    });
    if (directive.action !== "migrate") {
        throw new Error("Expected all-origin migration directive");
    }
    return directive;
}

function expectedMigratedRun(
    source: Readonly<{ id: string; revision: number }>,
    target: NonNullable<ReturnType<typeof buildDirective>["runs"]>[number],
) {
    return {
        id: source.id,
        revision: source.revision + 1,
        triggerEvidenceEnvelope: target.triggerEvidenceEnvelope,
        occurrenceEvidenceEqualityTag: target.occurrenceEvidenceEqualityTag,
        executionInputEnvelope: target.executionInputEnvelope,
        resultEnvelope: target.resultEnvelope,
        replyContextEnvelope: target.replyContextEnvelope,
        replyHandoffReceiptEnvelope: target.replyHandoffReceiptEnvelope,
        summaryCiphertext: null,
    };
}

/**
 * The canonical all-origin retained-Run migration-participant assertion. Both
 * SQLite integration and PostgreSQL DB-contract suites call this exact scenario.
 */
export async function assertAllOriginAutomationRunMigrationToE2ee(params?: Readonly<{
    onAccountCreated?: (accountId: string) => void;
}>) {
    const seeded = await seedAllOriginRuns(params?.onAccountCreated);
    const directive = buildDirective(seeded);
    const [eventTarget, conversationTarget, scheduledTarget, manualTarget] = directive.runs!;

    await expect(inTx(async (tx) =>
        await migrateAutomationAccountEncryptionInTx({
            tx,
            accountId: seeded.account.id,
            toMode: "e2ee",
            directive,
        }),
    )).resolves.toEqual({ status: "applied" });

    await expect(db.automationRun.findUniqueOrThrow({
        where: { id: seeded.eventRun.id },
        select: runContentSelect,
    })).resolves.toEqual(expectedMigratedRun(seeded.eventRun, eventTarget!));
    await expect(db.automationRun.findUniqueOrThrow({
        where: { id: seeded.conversationRun.id },
        select: runContentSelect,
    })).resolves.toEqual(expectedMigratedRun(seeded.conversationRun, conversationTarget!));
    await expect(db.automationRun.findUniqueOrThrow({
        where: { id: seeded.scheduledRun.id },
        select: runContentSelect,
    })).resolves.toEqual(expectedMigratedRun(seeded.scheduledRun, scheduledTarget!));
    await expect(db.automationRun.findUniqueOrThrow({
        where: { id: seeded.manualRun.id },
        select: runContentSelect,
    })).resolves.toEqual(expectedMigratedRun(seeded.manualRun, manualTarget!));
    await expect(db.automation.findUniqueOrThrow({
        where: { id: seeded.eventAutomation.id },
        select: {
            templateCiphertext: true,
            templateVersion: true,
            triggerDefinitionEnvelope: true,
        },
    })).resolves.toEqual({
        templateCiphertext: directive.templates[0]!.templateCiphertext,
        templateVersion: seeded.eventAutomation.templateVersion + 1,
        triggerDefinitionEnvelope: directive.templates[0]!.triggerDefinitionEnvelope,
    });
    await expect(db.automation.findUniqueOrThrow({
        where: { id: seeded.conversationAutomation.id },
        select: {
            templateCiphertext: true,
            templateVersion: true,
            triggerDefinitionEnvelope: true,
        },
    })).resolves.toEqual({
        templateCiphertext: directive.templates[1]!.templateCiphertext,
        templateVersion: seeded.conversationAutomation.templateVersion + 1,
        triggerDefinitionEnvelope: null,
    });
    await expect(inTx(async (tx) =>
        await matchAutomationAccountEncryptionMigrationPostStateInTx({
            tx,
            accountId: seeded.account.id,
            toMode: "e2ee",
            directive,
        }),
    )).resolves.toEqual({ status: "matched" });

}
