import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS } from "./automationReplyHandoffService";
import { runAutomationReplyHandoffWorkerPass } from "./automationReplyHandoffWorker";

const ACCOUNT_ID = "account-reply-handoff-worker";
const AUTOMATION_ID = "automation-reply-handoff-worker";
const RUN_ID = "run-reply-handoff-worker";
const HANDOFF_ID = "handoff-reply-handoff-worker";
const OCCURRENCE_KEY = "A".repeat(43);
const NOW = new Date("2026-08-10T12:00:00.000Z");

const RESULT_ENVELOPE = {
    t: "plain" as const,
    v: {
        v: 1 as const,
        correspondence: {
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
            runId: RUN_ID,
            handoffId: HANDOFF_ID,
        },
        result: { v: 1 as const, kind: "text" as const, text: "Finished" },
    },
};
const REPLY_CONTEXT_ENVELOPE = {
    t: "plain" as const,
    v: {
        v: 1 as const,
        correspondence: {
            automationId: AUTOMATION_ID,
            occurrenceKey: OCCURRENCE_KEY,
        },
        templateVersion: 1,
        opaqueContext: {
            conversationId: "conversation-1",
            messageId: "message-1",
        },
    },
};

describe("Automation reply handoff worker", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-reply-handoff-worker-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        await harness?.resetDbTables([
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedReadyHandoff(): Promise<void> {
        await db.account.create({
            data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" },
        });
        await db.automation.create({
            data: {
                id: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Conversation reply",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "reply" },
                }),
                templateVersion: 1,
                // Channel admission supplies the Conversation Run origin; the
                // Definition itself remains a normal schedule.
                triggerKind: "schedule",
                scheduleKind: "interval",
                everyMs: 60_000,
                triggerDefinitionEnvelope: null,
            },
        });
        await db.automationRun.create({
            data: {
                id: RUN_ID,
                automationId: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                state: "succeeded",
                originKind: "conversation",
                originOccurredAt: NOW,
                occurrenceKey: OCCURRENCE_KEY,
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                resultEnvelope: JSON.stringify(RESULT_ENVELOPE),
                replyContextEnvelope: JSON.stringify(REPLY_CONTEXT_ENVELOPE),
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation/result-deliver-v1",
                replyHandoffTargetMachineId: "machine-1",
                replyHandoffTargetMachineInstallationId: "installation-1",
                replyHandoffTargetMaterializationId: "materialization-1",
                replyHandoffId: HANDOFF_ID,
                replyHandoffState: "ready",
                replyHandoffAttempt: 0,
                replyHandoffDueAt: NOW,
                scheduledAt: NOW,
                dueAt: NOW,
                finishedAt: NOW,
            },
        });
    }

    async function readCurrentness() {
        const account = await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        });
        expect(account.encryptionMode).toBe("plain");
        return { mode: "plain" as const, version: account.seq, contentKeyFingerprint: null };
    }

    it("routes only the frozen target and opaque stored envelopes, then persists accepted custody", async () => {
        await seedReadyHandoff();
        let claimedCurrentness: Awaited<ReturnType<typeof readCurrentness>> | null = null;
        let dispatched: unknown = null;

        await runAutomationReplyHandoffWorkerPass({
            now: NOW,
            dispatch: async (request) => {
                dispatched = request;
                const accountCurrentness = await readCurrentness();
                claimedCurrentness = accountCurrentness;
                return {
                    kind: "settled",
                    settlement: { kind: "accepted" },
                    accountCurrentness,
                    receiptEnvelope: {
                        t: "plain",
                        v: {
                            v: 1,
                            correspondence: RESULT_ENVELOPE.v.correspondence,
                            result: { kind: "accepted", custodyId: "custody-1" },
                        },
                    },
                };
            },
        });
        if (!claimedCurrentness) throw new Error("expected claimed Account currentness");

        expect(dispatched).toEqual({
            v: 1,
            kind: "automation.replyHandoff.dispatch",
            target: {
                accountId: ACCOUNT_ID,
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
                actionRef: {
                    pluginId: "happier.channels",
                    localId: "automation/result-deliver-v1",
                },
            },
            handoff: {
                handoffId: HANDOFF_ID,
                runId: RUN_ID,
                automationId: AUTOMATION_ID,
                occurrenceKey: OCCURRENCE_KEY,
                accountCurrentness: claimedCurrentness,
                resultEnvelope: RESULT_ENVELOPE,
                replyContextEnvelope: REPLY_CONTEXT_ENVELOPE,
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffReceiptEnvelope: true },
        })).resolves.toEqual({
            replyHandoffState: "accepted",
            replyHandoffReceiptEnvelope: JSON.stringify({
                t: "plain",
                v: {
                    v: 1,
                    correspondence: RESULT_ENVELOPE.v.correspondence,
                    result: { kind: "accepted", custodyId: "custody-1" },
                },
            }),
        });
    });

    it.each(["targetUnavailable", "cancelled"] as const)("returns %s to the same stable ready handoff with the bounded retry", async (code) => {
        await seedReadyHandoff();

        await runAutomationReplyHandoffWorkerPass({
            now: NOW,
            dispatch: async () => ({ kind: "unavailable", code }),
        });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffAttempt: 1,
            replyHandoffDueAt: new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS),
            replyHandoffReceiptEnvelope: null,
        });
    });

    it("makes an unavailable Action durable attention instead of retrying a contract failure", async () => {
        await seedReadyHandoff();

        await runAutomationReplyHandoffWorkerPass({
            now: NOW,
            dispatch: async () => ({ kind: "unavailable", code: "actionUnavailable" }),
        });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffDueAt: true },
        })).resolves.toEqual({ replyHandoffState: "blocked", replyHandoffDueAt: null });
    });
});
