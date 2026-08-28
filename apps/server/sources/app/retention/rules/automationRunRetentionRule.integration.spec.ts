import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializeAutomationRunExecutionRecipeV1 } from "@happier-dev/protocol";

import type {
    AutomationExecutionDispatchState,
    AutomationRunReplyHandoffState,
    AutomationRunState,
} from "@/app/automations/automationTypes";
import { clearAutomationRunHistory } from "@/app/automations/automationCrudService";
import type { RetentionPolicy } from "@/app/retention/config/retentionPolicyTypes";
import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAutomationRunRetentionRule } from "./automationRunRetentionRule";

function createPolicy(automationRunDays = 1): RetentionPolicy {
    const keepForever = { mode: "keep_forever" as const };
    return {
        enabled: true,
        intervalMs: 60_000,
        batchSize: 100,
        dryRun: false,
        maxDeletesPerRulePerRun: 100,
        domains: {
            sessions: keepForever,
            sessionSidechainMessages: keepForever,
            accountChanges: keepForever,
            usageEvents: keepForever,
            voiceSessionLeases: keepForever,
            userFeedItems: keepForever,
            sessionShareAccessLogs: keepForever,
            publicShareAccessLogs: keepForever,
            terminalAuthRequests: keepForever,
            accountAuthRequests: keepForever,
            authPairingSessions: keepForever,
            repeatKeys: keepForever,
            globalLocks: keepForever,
            automationRuns: { mode: "delete_older_than", days: automationRunDays },
            automationRunEvents: keepForever,
        },
    };
}

function createGloballyDisabledPolicy(): RetentionPolicy {
    const policy = createPolicy();
    return {
        ...policy,
        enabled: false,
        domains: {
            ...policy.domains,
            automationRuns: { mode: "keep_forever" },
        },
    };
}

type RunFixture = Readonly<{
    id: string;
    state: AutomationRunState;
    executionDispatchState?: AutomationExecutionDispatchState;
    executionAttempt?: number;
    errorCode?: string;
    replyHandoffState?: AutomationRunReplyHandoffState;
    replyHandoffAttempt?: number;
    replyHandoffDueAt?: Date | null;
}>;

const RETENTION_FROZEN_EXECUTION_INPUT = (() => {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        assignmentMachineIds: [],
        template: { t: "plain", v: { v: 1, prompt: "Retained work" } },
        triggerEvidence: null,
        target: {
            kind: "executionRun",
            request: {
                intent: "task",
                backendTarget: { kind: "builtInAgent", agentId: "codex" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
            },
        },
    });
    if (serialized.kind !== "available") throw new Error("invalid retention Run fixture");
    return serialized.serialized;
})();

function conversationReplyHandoffFixture(
    id: string,
    state: Exclude<AutomationRunReplyHandoffState, "none">,
) {
    return {
        replyContextEnvelope: JSON.stringify({ t: "plain", v: {} }),
        replyHandoffActionPluginId: "happier.channels",
        replyHandoffActionLocalId: "automation/result-deliver-v1",
        replyHandoffTargetMachineId: "machine-retention",
        replyHandoffTargetMachineInstallationId: "installation-retention",
        replyHandoffTargetMaterializationId: "materialization-retention",
        replyHandoffId: `handoff-${id}`,
        replyHandoffState: state,
    } as const;
}

describe("automationRunRetentionRule", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-run-retention-",
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.automationRunEvent.deleteMany(),
            () => db.automationWorkerClaimReceipt.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("prunes expired signed-claim receipts through the existing Automation retention owner", async () => {
        const account = await db.account.create({
            data: { id: "account-claim-receipt-retention", encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automationWorkerClaimReceipt.createMany({
            data: [
                {
                    id: "expired-claim-receipt",
                    accountId: account.id,
                    machineId: "machine-receipt",
                    machineInstallationId: "installation-receipt",
                    expiresAt: new Date("2026-08-11T23:59:59.000Z"),
                },
                {
                    id: "current-claim-receipt",
                    accountId: account.id,
                    machineId: "machine-receipt",
                    machineInstallationId: "installation-receipt",
                    expiresAt: new Date("2026-08-12T00:05:00.000Z"),
                },
            ],
        });

        const rule = createAutomationRunRetentionRule();
        await expect(rule.run({
            policy: createPolicy(),
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 100,
            now: new Date("2026-08-12T00:00:00.000Z"),
        })).resolves.toEqual({
            id: "automationRuns",
            deleted: 1,
            candidatesExamined: 1,
            hasMore: false,
        });
        await expect(db.automationWorkerClaimReceipt.findMany({
            select: { id: true },
        })).resolves.toEqual([{ id: "current-claim-receipt" }]);
    });

    it("prunes terminal Runs only after an applicable Conversation reply handoff is terminal", async () => {
        const account = await db.account.create({
            data: { id: "account-automation-run-retention", encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automation.createMany({
            data: [
                {
                    id: "automation-event-retention",
                    accountId: account.id,
                    name: "Event retention",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
                {
                    id: "automation-conversation-retention",
                    accountId: account.id,
                    name: "Conversation retention",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
            ],
        });
        await db.automationTrigger.create({
            data: {
                id: "trigger-event-retention",
                automationId: "automation-event-retention",
                kind: "pluginEvent",
                eventPluginId: "plugin.retention",
                eventLocalId: "event/retention",
                sourceSelectorId: "retention-source-selector",
                sourceContractVersion: 1,
                observationTransport: "checkpointedPull",
                definitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
            },
        });

        const finishedAt = new Date("2026-08-10T00:00:00.000Z");
        const triggerEvidenceEnvelope = JSON.stringify({ t: "plain", v: {} });
        const pluginEventRun = (fixture: RunFixture) => ({
            ...fixture,
            ...(["queued", "claimed", "running"].includes(fixture.state)
                ? { executionInputEnvelope: RETENTION_FROZEN_EXECUTION_INPUT }
                : {}),
            automationId: "automation-event-retention",
            accountId: account.id,
            triggerId: "trigger-event-retention",
            causeKind: "trigger" as const,
            causeTriggerKind: "pluginEvent" as const,
            causeTriggerRevision: 0,
            causeOccurredAt: finishedAt,
            occurrenceKey: `retention-event-${fixture.id}`,
            causeEventPluginId: "plugin.retention",
            causeEventLocalId: "event/retention",
            causeSourceSelectorId: "retention-source-selector",
            triggerEvidenceEnvelope,
            scheduledAt: finishedAt,
            dueAt: finishedAt,
            finishedAt,
        });
        const conversationRun = (fixture: RunFixture) => {
            const hasReplyHandoff = fixture.replyHandoffState !== undefined
                && fixture.replyHandoffState !== "none";
            const handoffId = `retention-handoff-${fixture.id}`;
            return {
                ...fixture,
                automationId: "automation-conversation-retention",
                accountId: account.id,
                triggerId: null,
                causeKind: "conversation" as const,
                causeOccurredAt: finishedAt,
                occurrenceKey: `retention-conversation-${fixture.id}`,
                legacyManualIdempotencyKey: null,
                triggerEvidenceEnvelope,
                ...(hasReplyHandoff
                    ? {
                        resultEnvelope: JSON.stringify({ t: "plain", v: {} }),
                        replyContextEnvelope: JSON.stringify({ t: "plain", v: {} }),
                        replyHandoffActionPluginId: "happier.channels",
                        replyHandoffActionLocalId: "automation/result-deliver-v1",
                        replyHandoffTargetMachineId: "machine-retention",
                        replyHandoffTargetMachineInstallationId: "installation-retention",
                        replyHandoffTargetMaterializationId: "materialization-retention",
                        replyHandoffId: handoffId,
                        replyHandoffAttempt: fixture.replyHandoffAttempt ?? 0,
                        replyHandoffDueAt: fixture.replyHandoffDueAt ?? null,
                    }
                    : {}),
                scheduledAt: finishedAt,
                dueAt: finishedAt,
                finishedAt,
            };
        };
        await db.automationRun.createMany({
            data: [
                pluginEventRun({
                    id: "run-plugin-event-no-handoff",
                    state: "succeeded",
                }),
                pluginEventRun({
                    id: "run-failed-normal",
                    state: "failed",
                }),
                pluginEventRun({
                    id: "run-failed-exhausted-execution",
                    state: "failed",
                    executionDispatchState: "settled",
                    executionAttempt: 3,
                    errorCode: "execution_run_retry_exhausted",
                }),
                pluginEventRun({
                    id: "run-cancelled",
                    state: "cancelled",
                }),
                pluginEventRun({
                    id: "run-expired",
                    state: "expired",
                }),
                pluginEventRun({
                    id: "run-dispatch-failed",
                    state: "dispatch_failed",
                }),
                pluginEventRun({
                    id: "run-skipped",
                    state: "skipped",
                }),
                pluginEventRun({
                    id: "run-missed",
                    state: "missed",
                }),
                pluginEventRun({
                    id: "run-outcome-uncertain",
                    state: "outcome_uncertain",
                    executionDispatchState: "outcomeUnknown",
                }),
                conversationRun({
                    id: "run-conversation-awaiting-result",
                    state: "succeeded",
                    replyHandoffState: "awaitingResult",
                }),
                conversationRun({
                    id: "run-conversation-ready",
                    state: "succeeded",
                    replyHandoffState: "ready",
                    replyHandoffDueAt: new Date("2026-08-12T00:01:00.000Z"),
                }),
                conversationRun({
                    id: "run-conversation-handing-off",
                    state: "succeeded",
                    replyHandoffState: "handingOff",
                    replyHandoffAttempt: 1,
                    replyHandoffDueAt: new Date("2026-08-12T00:01:00.000Z"),
                }),
                conversationRun({
                    id: "run-conversation-accepted",
                    state: "succeeded",
                    replyHandoffState: "accepted",
                }),
                conversationRun({
                    id: "run-conversation-suppressed",
                    state: "succeeded",
                    replyHandoffState: "suppressed",
                }),
                conversationRun({
                    id: "run-conversation-blocked",
                    state: "succeeded",
                    replyHandoffState: "blocked",
                }),
                conversationRun({
                    id: "run-conversation-failed-ready",
                    state: "failed",
                    replyHandoffState: "ready",
                    replyHandoffDueAt: new Date("2026-08-12T00:01:00.000Z"),
                }),
                pluginEventRun({
                    id: "run-queued",
                    state: "queued",
                }),
                pluginEventRun({
                    id: "run-claimed",
                    state: "claimed",
                }),
                pluginEventRun({
                    id: "run-running",
                    state: "running",
                }),
            ],
        });

        const rule = createAutomationRunRetentionRule();
        await expect(rule.run({
            policy: createPolicy(),
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 100,
            now: new Date("2026-08-12T00:00:00.000Z"),
        })).resolves.toEqual({
            id: "automationRuns",
            deleted: 12,
            candidatesExamined: 12,
            hasMore: false,
        });

        await expect(db.automationRun.findMany({
            where: { accountId: account.id },
            orderBy: { id: "asc" },
            select: { id: true, state: true },
        })).resolves.toEqual([
            { id: "run-claimed", state: "claimed" },
            { id: "run-conversation-awaiting-result", state: "succeeded" },
            { id: "run-conversation-failed-ready", state: "failed" },
            { id: "run-conversation-handing-off", state: "succeeded" },
            { id: "run-conversation-ready", state: "succeeded" },
            { id: "run-queued", state: "queued" },
            { id: "run-running", state: "running" },
        ]);
    });

    it("applies the Account default even when global retention is disabled without erasing newer history content", async () => {
        const account = await db.account.create({
            data: { id: "account-automation-account-default-retention", encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automation.create({
            data: {
                id: "automation-account-default-retention",
                accountId: account.id,
                name: "Account default retention",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: "retention-fixture",
                templateVersion: 1,
            },
        });
        const keepForeverAccount = await db.account.create({
            data: {
                id: "account-automation-account-keep-forever",
                encryptionMode: "plain",
                automationRunRetention: "keepForever",
            },
            select: { id: true },
        });
        await db.automation.create({
            data: {
                id: "automation-account-keep-forever",
                accountId: keepForeverAccount.id,
                name: "Account keep forever retention",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: "retention-fixture",
                templateVersion: 1,
            },
        });

        const now = new Date("2026-08-12T00:00:00.000Z");
        const recentFinishedAt = new Date("2026-08-02T00:00:00.000Z");
        await db.automationRun.createMany({
            data: [
                {
                    id: "run-account-default-aged",
                    automationId: "automation-account-default-retention",
                    accountId: account.id,
                    state: "failed",
                    causeKind: "manual",
                    causeOccurredAt: new Date("2026-07-01T00:00:00.000Z"),
                    scheduledAt: new Date("2026-07-01T00:00:00.000Z"),
                    dueAt: new Date("2026-07-01T00:00:00.000Z"),
                    finishedAt: new Date("2026-07-01T00:00:00.000Z"),
                },
                {
                    id: "run-account-default-recent",
                    automationId: "automation-account-default-retention",
                    accountId: account.id,
                    state: "failed",
                    causeKind: "manual",
                    causeOccurredAt: recentFinishedAt,
                    executionInputEnvelope: "private-input",
                    resultEnvelope: "private-result",
                    summaryCiphertext: "private-summary",
                    errorMessage: "private-error",
                    scheduledAt: recentFinishedAt,
                    dueAt: recentFinishedAt,
                    finishedAt: recentFinishedAt,
                },
                {
                    id: "run-account-keep-forever-aged",
                    automationId: "automation-account-keep-forever",
                    accountId: keepForeverAccount.id,
                    state: "failed",
                    causeKind: "manual",
                    causeOccurredAt: new Date("2026-07-01T00:00:00.000Z"),
                    scheduledAt: new Date("2026-07-01T00:00:00.000Z"),
                    dueAt: new Date("2026-07-01T00:00:00.000Z"),
                    finishedAt: new Date("2026-07-01T00:00:00.000Z"),
                },
            ],
        });

        const rule = createAutomationRunRetentionRule();
        await expect(rule.run({
            policy: createGloballyDisabledPolicy(),
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 100,
            now,
        })).resolves.toMatchObject({
            id: "automationRuns",
            deleted: 1,
        });

        await expect(db.automationRun.findUnique({
            where: { id: "run-account-default-aged" },
            select: { id: true },
        })).resolves.toBeNull();
        await expect(db.automationRun.findUnique({
            where: { id: "run-account-keep-forever-aged" },
            select: { id: true },
        })).resolves.toEqual({ id: "run-account-keep-forever-aged" });
        await expect(db.automationRun.findUnique({
            where: { id: "run-account-default-recent" },
            select: {
                executionInputEnvelope: true,
                resultEnvelope: true,
                replyContextEnvelope: true,
                replyHandoffReceiptEnvelope: true,
                summaryCiphertext: true,
                errorMessage: true,
            },
        })).resolves.toEqual({
            executionInputEnvelope: "private-input",
            resultEnvelope: "private-result",
            replyContextEnvelope: null,
            replyHandoffReceiptEnvelope: null,
            summaryCiphertext: "private-summary",
            errorMessage: "private-error",
        });
    });

    it("treats a finite global Automation policy as the maximum Account history age", async () => {
        const defaultAccount = await db.account.create({
            data: { id: "account-automation-global-maximum-default", encryptionMode: "plain" },
            select: { id: true },
        });
        const keepForeverAccount = await db.account.create({
            data: {
                id: "account-automation-global-maximum-keep-forever",
                encryptionMode: "plain",
                automationRunRetention: "keepForever",
            },
            select: { id: true },
        });
        await db.automation.createMany({
            data: [
                {
                    id: "automation-global-maximum-default",
                    accountId: defaultAccount.id,
                    name: "Global maximum default",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
                {
                    id: "automation-global-maximum-keep-forever",
                    accountId: keepForeverAccount.id,
                    name: "Global maximum keep forever",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
            ],
        });
        const now = new Date("2026-08-12T00:00:00.000Z");
        const tenDaysAgo = new Date("2026-08-02T00:00:00.000Z");
        const fiveDaysAgo = new Date("2026-08-07T00:00:00.000Z");
        await db.automationRun.createMany({
            data: [
                {
                    id: "run-global-maximum-default",
                    automationId: "automation-global-maximum-default",
                    accountId: defaultAccount.id,
                    state: "failed",
                    causeKind: "manual",
                    causeOccurredAt: tenDaysAgo,
                    scheduledAt: tenDaysAgo,
                    dueAt: tenDaysAgo,
                    finishedAt: tenDaysAgo,
                },
                {
                    id: "run-global-maximum-keep-forever-aged",
                    automationId: "automation-global-maximum-keep-forever",
                    accountId: keepForeverAccount.id,
                    state: "failed",
                    causeKind: "manual",
                    causeOccurredAt: tenDaysAgo,
                    scheduledAt: tenDaysAgo,
                    dueAt: tenDaysAgo,
                    finishedAt: tenDaysAgo,
                },
                {
                    id: "run-global-maximum-keep-forever-recent",
                    automationId: "automation-global-maximum-keep-forever",
                    accountId: keepForeverAccount.id,
                    state: "failed",
                    causeKind: "manual",
                    causeOccurredAt: fiveDaysAgo,
                    scheduledAt: fiveDaysAgo,
                    dueAt: fiveDaysAgo,
                    finishedAt: fiveDaysAgo,
                },
            ],
        });

        const rule = createAutomationRunRetentionRule();
        await expect(rule.run({
            policy: createPolicy(7),
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 100,
            now,
        })).resolves.toMatchObject({ id: "automationRuns", deleted: 2 });

        await expect(db.automationRun.findMany({
            where: {
                id: {
                    in: [
                        "run-global-maximum-default",
                        "run-global-maximum-keep-forever-aged",
                        "run-global-maximum-keep-forever-recent",
                    ],
                },
            },
            orderBy: { id: "asc" },
            select: { id: true },
        })).resolves.toEqual([
            { id: "run-global-maximum-keep-forever-recent" },
        ]);
    });

    it("retains full terminal Event and Conversation content until history deletion", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                id: "account-automation-retention-compaction",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        await db.automation.create({
            data: {
                id: "automation-retention-compaction-event",
                accountId: account.id,
                name: "Retention Event",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: "retention-fixture",
                templateVersion: 1,
                triggers: { create: {
                    id: "trigger-retention-content-event",
                    kind: "pluginEvent",
                    eventPluginId: "plugin.retention",
                    eventLocalId: "event/compaction",
                    sourceSelectorId: "retention-compaction-source",
                    sourceContractVersion: 1,
                    observationTransport: "checkpointedPull",
                    definitionEnvelope: "opaque-definition",
                } },
            },
        });
        await db.automation.create({
            data: {
                id: "automation-retention-compaction-conversation",
                accountId: account.id,
                name: "Retention Conversation",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: "retention-fixture",
                templateVersion: 1,
            },
        });
        const now = new Date("2026-08-12T00:00:00.000Z");
        const finishedAt = new Date("2026-08-02T00:00:00.000Z");
        const equalityTag = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        const eventEvidence = JSON.stringify({ t: "encrypted", c: "opaque-event-evidence" });
        const conversationEvidence = JSON.stringify({ t: "encrypted", c: "opaque-conversation-evidence" });
        const activeEvidence = JSON.stringify({ t: "encrypted", c: "opaque-active-evidence" });
        await db.automationRun.createMany({
            data: [
                {
                    id: "run-retention-compaction-event",
                    automationId: "automation-retention-compaction-event",
                    accountId: account.id,
                    state: "failed",
                    triggerId: "trigger-retention-content-event",
                    causeKind: "trigger",
                    causeTriggerKind: "pluginEvent",
                    causeTriggerRevision: 0,
                    causeOccurredAt: finishedAt,
                    occurrenceKey: "retention-compaction-event",
                    occurrenceEvidenceEqualityTag: equalityTag,
                    causeEventPluginId: "plugin.retention",
                    causeEventLocalId: "event/compaction",
                    causeSourceSelectorId: "retention-compaction-source",
                    triggerEvidenceEnvelope: eventEvidence,
                    executionInputEnvelope: "opaque-event-input",
                    resultEnvelope: "opaque-event-result",
                    summaryCiphertext: "opaque-event-summary",
                    errorMessage: "opaque-event-error",
                    scheduledAt: finishedAt,
                    dueAt: finishedAt,
                    finishedAt,
                },
                {
                    id: "run-retention-compaction-conversation",
                    automationId: "automation-retention-compaction-conversation",
                    accountId: account.id,
                    state: "succeeded",
                    causeKind: "conversation",
                    causeOccurredAt: finishedAt,
                    occurrenceKey: "retention-compaction-conversation",
                    legacyManualIdempotencyKey: null,
                    occurrenceEvidenceEqualityTag: equalityTag,
                    triggerEvidenceEnvelope: conversationEvidence,
                    executionInputEnvelope: "opaque-conversation-input",
                    resultEnvelope: "opaque-conversation-result",
                    replyContextEnvelope: "opaque-conversation-context",
                    replyHandoffActionPluginId: "happier.channels",
                    replyHandoffActionLocalId: "automation/result-deliver-v1",
                    replyHandoffTargetMachineId: "machine-retention-compaction",
                    replyHandoffTargetMachineInstallationId: "installation-retention-compaction",
                    replyHandoffTargetMaterializationId: "materialization-retention-compaction",
                    replyHandoffId: "handoff-retention-compaction",
                    replyHandoffState: "accepted",
                    replyHandoffReceiptEnvelope: "opaque-conversation-receipt",
                    summaryCiphertext: "opaque-conversation-summary",
                    errorMessage: "opaque-conversation-error",
                    scheduledAt: finishedAt,
                    dueAt: finishedAt,
                    finishedAt,
                },
                {
                    id: "run-retention-compaction-active",
                    automationId: "automation-retention-compaction-event",
                    accountId: account.id,
                    state: "running",
                    triggerId: "trigger-retention-content-event",
                    causeKind: "trigger",
                    causeTriggerKind: "pluginEvent",
                    causeTriggerRevision: 0,
                    causeOccurredAt: finishedAt,
                    occurrenceKey: "retention-compaction-active",
                    occurrenceEvidenceEqualityTag: equalityTag,
                    causeEventPluginId: "plugin.retention",
                    causeEventLocalId: "event/compaction",
                    causeSourceSelectorId: "retention-compaction-source",
                    triggerEvidenceEnvelope: activeEvidence,
                    executionInputEnvelope: "opaque-active-input",
                    scheduledAt: finishedAt,
                    dueAt: finishedAt,
                },
            ],
        });

        const rule = createAutomationRunRetentionRule();
        await expect(rule.run({
            policy: createGloballyDisabledPolicy(),
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 100,
            now,
        })).resolves.toMatchObject({ id: "automationRuns", deleted: 0 });

        await expect(db.automationRun.findMany({
            where: { accountId: account.id },
            orderBy: { id: "asc" },
            select: {
                id: true,
                triggerId: true,
                causeKind: true,
                causeTriggerKind: true,
                causeTriggerRevision: true,
                causeOccurredAt: true,
                causeEventPluginId: true,
                causeEventLocalId: true,
                causeSourceSelectorId: true,
                occurrenceKey: true,
                triggerEvidenceEnvelope: true,
                occurrenceEvidenceEqualityTag: true,
                executionInputEnvelope: true,
                resultEnvelope: true,
                replyContextEnvelope: true,
                replyHandoffReceiptEnvelope: true,
                summaryCiphertext: true,
                errorMessage: true,
            },
        })).resolves.toEqual([
            {
                id: "run-retention-compaction-active",
                triggerId: "trigger-retention-content-event",
                causeKind: "trigger",
                causeTriggerKind: "pluginEvent",
                causeTriggerRevision: 0,
                causeOccurredAt: finishedAt,
                causeEventPluginId: "plugin.retention",
                causeEventLocalId: "event/compaction",
                causeSourceSelectorId: "retention-compaction-source",
                occurrenceKey: "retention-compaction-active",
                triggerEvidenceEnvelope: activeEvidence,
                occurrenceEvidenceEqualityTag: equalityTag,
                executionInputEnvelope: "opaque-active-input",
                resultEnvelope: null,
                replyContextEnvelope: null,
                replyHandoffReceiptEnvelope: null,
                summaryCiphertext: null,
                errorMessage: null,
            },
            {
                id: "run-retention-compaction-conversation",
                triggerId: null,
                causeKind: "conversation",
                causeTriggerKind: null,
                causeTriggerRevision: null,
                causeOccurredAt: finishedAt,
                causeEventPluginId: null,
                causeEventLocalId: null,
                causeSourceSelectorId: null,
                occurrenceKey: "retention-compaction-conversation",
                triggerEvidenceEnvelope: conversationEvidence,
                occurrenceEvidenceEqualityTag: equalityTag,
                executionInputEnvelope: "opaque-conversation-input",
                resultEnvelope: "opaque-conversation-result",
                replyContextEnvelope: "opaque-conversation-context",
                replyHandoffReceiptEnvelope: "opaque-conversation-receipt",
                summaryCiphertext: "opaque-conversation-summary",
                errorMessage: "opaque-conversation-error",
            },
            {
                id: "run-retention-compaction-event",
                triggerId: "trigger-retention-content-event",
                causeKind: "trigger",
                causeTriggerKind: "pluginEvent",
                causeTriggerRevision: 0,
                causeOccurredAt: finishedAt,
                causeEventPluginId: "plugin.retention",
                causeEventLocalId: "event/compaction",
                causeSourceSelectorId: "retention-compaction-source",
                occurrenceKey: "retention-compaction-event",
                triggerEvidenceEnvelope: eventEvidence,
                occurrenceEvidenceEqualityTag: equalityTag,
                executionInputEnvelope: "opaque-event-input",
                resultEnvelope: "opaque-event-result",
                replyContextEnvelope: null,
                replyHandoffReceiptEnvelope: null,
                summaryCiphertext: "opaque-event-summary",
                errorMessage: "opaque-event-error",
            },
        ]);
    });

    it("clears only one Automation's safely terminal history", async () => {
        const account = await db.account.create({
            data: { id: "account-automation-manual-clear", encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automation.createMany({
            data: [
                {
                    id: "automation-manual-clear-target",
                    accountId: account.id,
                    name: "Clear target",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
                {
                    id: "automation-manual-clear-other",
                    accountId: account.id,
                    name: "Other history",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
            ],
        });
        const at = new Date("2026-08-10T00:00:00.000Z");
        await db.automationRun.createMany({
            data: [
                {
                    id: "run-manual-clear-terminal",
                    automationId: "automation-manual-clear-target",
                    accountId: account.id,
                    state: "failed",
                    causeKind: "manual",
                    causeOccurredAt: at,
                    scheduledAt: at,
                    dueAt: at,
                    finishedAt: at,
                },
                {
                    id: "run-manual-clear-queued",
                    automationId: "automation-manual-clear-target",
                    accountId: account.id,
                    state: "queued",
                    causeKind: "manual",
                    causeOccurredAt: at,
                    executionInputEnvelope: RETENTION_FROZEN_EXECUTION_INPUT,
                    scheduledAt: at,
                    dueAt: at,
                },
                {
                    id: "run-manual-clear-claimed",
                    automationId: "automation-manual-clear-target",
                    accountId: account.id,
                    state: "claimed",
                    causeKind: "manual",
                    causeOccurredAt: at,
                    executionInputEnvelope: RETENTION_FROZEN_EXECUTION_INPUT,
                    scheduledAt: at,
                    dueAt: at,
                },
                {
                    id: "run-manual-clear-running",
                    automationId: "automation-manual-clear-target",
                    accountId: account.id,
                    state: "running",
                    causeKind: "manual",
                    causeOccurredAt: at,
                    executionInputEnvelope: RETENTION_FROZEN_EXECUTION_INPUT,
                    scheduledAt: at,
                    dueAt: at,
                },
                {
                    id: "run-manual-clear-other",
                    automationId: "automation-manual-clear-other",
                    accountId: account.id,
                    state: "failed",
                    causeKind: "manual",
                    causeOccurredAt: at,
                    scheduledAt: at,
                    dueAt: at,
                    finishedAt: at,
                },
            ],
        });

        await expect(clearAutomationRunHistory({
            accountId: account.id,
            automationId: "automation-manual-clear-target",
        })).resolves.toEqual({ status: "cleared", clearedRuns: 1 });

        await expect(db.automationRun.findMany({
            where: { accountId: account.id },
            orderBy: { id: "asc" },
            select: { id: true, state: true },
        })).resolves.toEqual([
            { id: "run-manual-clear-claimed", state: "claimed" },
            { id: "run-manual-clear-other", state: "failed" },
            { id: "run-manual-clear-queued", state: "queued" },
            { id: "run-manual-clear-running", state: "running" },
        ]);
    });

    it("deletes a soft-deleted Automation's custody-terminal history even when the Account keeps live history forever", async () => {
        const account = await db.account.create({
            data: {
                id: "account-automation-finalize",
                encryptionMode: "plain",
                automationRunRetention: "keepForever",
            },
            select: { id: true },
        });
        const deletedAt = new Date("2026-08-01T00:00:00.000Z");
        await db.automation.createMany({
            data: [
                {
                    id: "automation-deleted-with-run",
                    accountId: account.id,
                    name: "Deleted with a retained Run",
                    enabled: false,
                    deletedAt,
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
                {
                    id: "automation-deleted-without-run",
                    accountId: account.id,
                    name: "Deleted with no retained Run",
                    enabled: false,
                    deletedAt,
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
                {
                    id: "automation-live",
                    accountId: account.id,
                    name: "Still live",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
            ],
        });
        const finishedAt = new Date("2026-08-10T00:00:00.000Z");
        await db.automationRun.createMany({
            data: [
                {
                    id: "run-finalize-expired",
                    automationId: "automation-deleted-without-run",
                    accountId: account.id,
                    state: "cancelled",
                    causeKind: "conversation",
                    triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    occurrenceKey: "retention-finalize-expired",
                    legacyManualIdempotencyKey: null,
                    causeOccurredAt: finishedAt,
                    scheduledAt: finishedAt,
                    dueAt: finishedAt,
                    finishedAt,
                    ...conversationReplyHandoffFixture("run-finalize-expired", "suppressed"),
                },
                {
                    id: "run-finalize-retained",
                    automationId: "automation-deleted-with-run",
                    accountId: account.id,
                    state: "running",
                    causeKind: "conversation",
                    triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    occurrenceKey: "retention-finalize-retained",
                    legacyManualIdempotencyKey: null,
                    causeOccurredAt: finishedAt,
                    executionInputEnvelope: RETENTION_FROZEN_EXECUTION_INPUT,
                    scheduledAt: finishedAt,
                    dueAt: finishedAt,
                    ...conversationReplyHandoffFixture("run-finalize-retained", "awaitingResult"),
                },
            ],
        });

        const rule = createAutomationRunRetentionRule();
        await expect(rule.run({
            policy: createGloballyDisabledPolicy(),
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 100,
            now: new Date("2026-08-12T00:00:00.000Z"),
        })).resolves.toMatchObject({ id: "automationRuns", deleted: 1 });

        // The parent whose last Run just disappeared is gone; the one that still
        // restricts its parent, and the live definition, are untouched.
        await expect(db.automation.findMany({
            where: { accountId: account.id },
            orderBy: { id: "asc" },
            select: { id: true },
        })).resolves.toEqual([
            { id: "automation-deleted-with-run" },
            { id: "automation-live" },
        ]);
    });

    it("finishes stranded soft-deleted Automations independently across Accounts", async () => {
        const [firstAccount, secondAccount] = await Promise.all([
            db.account.create({
                data: { id: "account-automation-finalize-first", encryptionMode: "plain" },
                select: { id: true },
            }),
            db.account.create({
                data: { id: "account-automation-finalize-second", encryptionMode: "plain" },
                select: { id: true },
            }),
        ]);
        await db.automation.createMany({
            data: [
                {
                    id: "automation-finalize-first-account",
                    accountId: firstAccount.id,
                    name: "First stranded definition",
                    enabled: false,
                    deletedAt: new Date("2026-08-01T00:00:00.000Z"),
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
                {
                    id: "automation-finalize-second-account",
                    accountId: secondAccount.id,
                    name: "Second stranded definition",
                    enabled: false,
                    deletedAt: new Date("2026-08-02T00:00:00.000Z"),
                    targetType: "execution_run",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                },
            ],
        });

        const rule = createAutomationRunRetentionRule();
        await expect(rule.run({
            policy: createPolicy(),
            batchSize: 2,
            dryRun: false,
            maxDeletesPerRulePerRun: 2,
            now: new Date("2026-08-12T00:00:00.000Z"),
        })).resolves.toEqual({
            id: "automationRuns",
            deleted: 0,
            candidatesExamined: 0,
            hasMore: false,
        });

        await expect(db.automation.count({
            where: { id: { in: ["automation-finalize-first-account", "automation-finalize-second-account"] } },
        })).resolves.toBe(0);
    });

    it("does not finalize a soft-deleted Automation during a dry run", async () => {
        const account = await db.account.create({
            data: { id: "account-automation-finalize-dry", encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automation.create({
            data: {
                id: "automation-deleted-dry-run",
                accountId: account.id,
                name: "Deleted during a dry run",
                enabled: false,
                deletedAt: new Date("2026-08-01T00:00:00.000Z"),
                targetType: "execution_run",
                templateCiphertext: "retention-fixture",
                templateVersion: 1,
            },
        });

        const rule = createAutomationRunRetentionRule();
        await rule.run({
            policy: createPolicy(),
            batchSize: 100,
            dryRun: true,
            maxDeletesPerRulePerRun: 100,
            now: new Date("2026-08-12T00:00:00.000Z"),
        });

        await expect(db.automation.count({
            where: { id: "automation-deleted-dry-run" },
        })).resolves.toBe(1);
    });
});
