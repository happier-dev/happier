import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
    AutomationExecutionDispatchState,
    AutomationRunReplyHandoffState,
    AutomationRunState,
} from "@/app/automations/automationTypes";
import type { RetentionPolicy } from "@/app/retention/config/retentionPolicyTypes";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAutomationRunRetentionRule } from "./automationRunRetentionRule";

function createPolicy(): RetentionPolicy {
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
            automationRuns: { mode: "delete_older_than", days: 1 },
            automationRunEvents: keepForever,
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
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.account.deleteMany(),
        ]);
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
                    triggerKind: "pluginEvent",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                    triggerEventPluginId: "plugin.retention",
                    triggerEventLocalId: "event/retention",
                    triggerSourceSelectorId: "retention-source-selector",
                    triggerSourceContractVersion: 1,
                    triggerObservationTransport: "checkpointedPull",
                    triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
                },
                {
                    id: "automation-conversation-retention",
                    accountId: account.id,
                    name: "Conversation retention",
                    enabled: true,
                    targetType: "execution_run",
                    triggerKind: "conversation",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                    triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
                },
            ],
        });

        const finishedAt = new Date("2026-08-10T00:00:00.000Z");
        const triggerEvidenceEnvelope = JSON.stringify({ t: "plain", v: {} });
        const pluginEventRun = (fixture: RunFixture) => ({
            ...fixture,
            automationId: "automation-event-retention",
            accountId: account.id,
            originKind: "pluginEvent" as const,
            originOccurredAt: finishedAt,
            occurrenceKey: `retention-event-${fixture.id}`,
            originSourceSelectorId: "retention-source-selector",
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
                originKind: "conversation" as const,
                originOccurredAt: finishedAt,
                occurrenceKey: `retention-conversation-${fixture.id}`,
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
                conversationRun({
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
                    id: "run-conversation-no-handoff",
                    state: "succeeded",
                    replyHandoffState: "none",
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
            deleted: 14,
            candidatesExamined: 14,
            hasMore: false,
        });

        await expect(db.automationRun.findMany({
            where: { accountId: account.id },
            orderBy: { id: "asc" },
            select: { id: true, state: true },
        })).resolves.toEqual([
            { id: "run-claimed", state: "claimed" },
            { id: "run-conversation-awaiting-result", state: "succeeded" },
            { id: "run-conversation-handing-off", state: "succeeded" },
            { id: "run-conversation-ready", state: "succeeded" },
            { id: "run-queued", state: "queued" },
            { id: "run-running", state: "running" },
        ]);
    });

    it("finishes a soft-deleted Automation's deletion once retention removed its last retained Run", async () => {
        const account = await db.account.create({
            data: { id: "account-automation-finalize", encryptionMode: "plain" },
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
                    triggerKind: "conversation",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                    triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
                },
                {
                    id: "automation-deleted-without-run",
                    accountId: account.id,
                    name: "Deleted with no retained Run",
                    enabled: false,
                    deletedAt,
                    targetType: "execution_run",
                    triggerKind: "conversation",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                    triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
                },
                {
                    id: "automation-live",
                    accountId: account.id,
                    name: "Still live",
                    enabled: true,
                    targetType: "execution_run",
                    triggerKind: "conversation",
                    templateCiphertext: "retention-fixture",
                    templateVersion: 1,
                    triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
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
                    originKind: "conversation",
                    triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    occurrenceKey: "retention-finalize-expired",
                    originOccurredAt: finishedAt,
                    scheduledAt: finishedAt,
                    dueAt: finishedAt,
                    finishedAt,
                },
                {
                    id: "run-finalize-retained",
                    automationId: "automation-deleted-with-run",
                    accountId: account.id,
                    state: "running",
                    originKind: "conversation",
                    triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    occurrenceKey: "retention-finalize-retained",
                    originOccurredAt: finishedAt,
                    scheduledAt: finishedAt,
                    dueAt: finishedAt,
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
                triggerKind: "conversation",
                templateCiphertext: "retention-fixture",
                templateVersion: 1,
                triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
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
