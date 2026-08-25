import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    claimNextAutomationReplyHandoff,
    findNextAutomationReplyHandoffDueAt,
    settleAutomationReplyHandoff,
} from "./automationReplyHandoffService";

const ACCOUNT_ID = "account-reply-handoff";
const AUTOMATION_ID = "automation-reply-handoff";
const RUN_ID = "run-reply-handoff";
const HANDOFF_ID = "handoff-reply-handoff";
const OCCURRENCE_KEY = "A".repeat(43);
const NOW = new Date("2026-08-10T12:00:00.000Z");
const EXPECTED_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS = 10_000;

const RESULT_ENVELOPE = JSON.stringify({
    t: "plain",
    v: {
        v: 1,
        correspondence: {
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
            runId: RUN_ID,
            handoffId: HANDOFF_ID,
        },
        result: { v: 1, kind: "text", text: "Finished" },
    },
});
const REPLY_CONTEXT_ENVELOPE = JSON.stringify({
    t: "plain",
    v: {
        v: 1,
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
});
const ACCEPTED_RECEIPT_ENVELOPE = {
    t: "plain" as const,
    v: {
        v: 1 as const,
        correspondence: {
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
            runId: RUN_ID,
            handoffId: HANDOFF_ID,
        },
        result: { kind: "accepted" as const, custodyId: "custody-1" },
    },
};
const SUPPRESSED_RECEIPT_ENVELOPE = {
    t: "plain" as const,
    v: {
        v: 1 as const,
        correspondence: {
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
            runId: RUN_ID,
            handoffId: HANDOFF_ID,
        },
        result: { kind: "suppressed" as const, reason: "bindingDisabled" },
    },
};

describe("Automation reply handoff service", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-reply-handoff-",
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

    async function seedReadyHandoff(params: Readonly<{
        dueAt?: Date;
        state?: "ready" | "handingOff";
        attempt?: number;
        resultEnvelope?: string;
        receiptEnvelope?: string;
    }> = {}): Promise<void> {
        const dueAt = params.dueAt ?? NOW;
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
                resultEnvelope: params.resultEnvelope ?? RESULT_ENVELOPE,
                replyContextEnvelope: REPLY_CONTEXT_ENVELOPE,
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation/result-deliver-v1",
                replyHandoffTargetMachineId: "machine-1",
                replyHandoffTargetMachineInstallationId: "installation-1",
                replyHandoffTargetMaterializationId: "materialization-1",
                replyHandoffId: HANDOFF_ID,
                replyHandoffState: params.state ?? "ready",
                replyHandoffAttempt: params.attempt ?? 0,
                replyHandoffDueAt: dueAt,
                replyHandoffReceiptEnvelope: params.receiptEnvelope ?? null,
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
        return {
            mode: "plain" as const,
            version: account.seq,
            contentKeyFingerprint: null,
        };
    }

    it("claims the earliest due ready handoff atomically and returns exact raw frozen envelopes", async () => {
        await seedReadyHandoff();

        await expect(findNextAutomationReplyHandoffDueAt({ now: NOW }))
            .resolves.toEqual(NOW);
        const [firstClaim, secondClaim] = await Promise.all([
            claimNextAutomationReplyHandoff({ now: NOW }),
            claimNextAutomationReplyHandoff({ now: NOW }),
        ]);
        const claim = [firstClaim, secondClaim].find((entry) => entry !== null) ?? null;
        expect([firstClaim, secondClaim].filter((entry) => entry !== null)).toHaveLength(1);
        const claimedCurrentness = await readCurrentness();

        expect(claim).toMatchObject({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
            runId: RUN_ID,
            handoffId: HANDOFF_ID,
            occurrenceKey: OCCURRENCE_KEY,
            attempt: 1,
            accountCurrentness: claimedCurrentness,
            runRevision: 1,
            resultEnvelope: RESULT_ENVELOPE,
            replyContextEnvelope: REPLY_CONTEXT_ENVELOPE,
            target: {
                actionPluginId: "happier.channels",
                actionLocalId: "automation/result-deliver-v1",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffAttempt: true, replyHandoffDueAt: true },
        })).resolves.toMatchObject({
            replyHandoffState: "handingOff",
            replyHandoffAttempt: 1,
        });
    });

    it("normalizes zero and omitted retry hints to the durable cadence while preserving positive hints and terminal settlement", async () => {
        await seedReadyHandoff();

        const firstClaim = await claimNextAutomationReplyHandoff({ now: NOW });
        expect(firstClaim).not.toBeNull();
        if (!firstClaim) return;
        await expect(settleAutomationReplyHandoff({
            claim: firstClaim,
            now: NOW,
            outcome: { kind: "retry", retryAfterMs: 0 },
        })).resolves.toEqual({ applied: true });
        const firstRetryAt = new Date(NOW.getTime() + EXPECTED_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS);
        await expect(findNextAutomationReplyHandoffDueAt({ now: NOW })).resolves.toEqual(firstRetryAt);

        const secondClaim = await claimNextAutomationReplyHandoff({ now: firstRetryAt });
        expect(secondClaim).not.toBeNull();
        if (!secondClaim) return;
        await expect(settleAutomationReplyHandoff({
            claim: secondClaim,
            now: firstRetryAt,
            outcome: { kind: "retry", retryAfterMs: 0 },
        })).resolves.toEqual({ applied: true });
        const secondRetryAt = new Date(
            firstRetryAt.getTime() + EXPECTED_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS,
        );
        await expect(findNextAutomationReplyHandoffDueAt({ now: firstRetryAt })).resolves.toEqual(secondRetryAt);

        const thirdClaim = await claimNextAutomationReplyHandoff({ now: secondRetryAt });
        expect(thirdClaim).not.toBeNull();
        if (!thirdClaim) return;
        await expect(settleAutomationReplyHandoff({
            claim: thirdClaim,
            now: secondRetryAt,
            outcome: { kind: "retry" },
        })).resolves.toEqual({ applied: true });
        const thirdRetryAt = new Date(
            secondRetryAt.getTime() + EXPECTED_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS,
        );
        await expect(findNextAutomationReplyHandoffDueAt({ now: secondRetryAt })).resolves.toEqual(thirdRetryAt);

        const fourthClaim = await claimNextAutomationReplyHandoff({ now: thirdRetryAt });
        expect(fourthClaim).not.toBeNull();
        if (!fourthClaim) return;
        await expect(settleAutomationReplyHandoff({
            claim: fourthClaim,
            now: thirdRetryAt,
            outcome: { kind: "retry", retryAfterMs: 1_234 },
        })).resolves.toEqual({ applied: true });
        const positiveHintRetryAt = new Date(thirdRetryAt.getTime() + 1_234);
        await expect(findNextAutomationReplyHandoffDueAt({ now: thirdRetryAt })).resolves.toEqual(positiveHintRetryAt);

        const acceptedClaim = await claimNextAutomationReplyHandoff({ now: positiveHintRetryAt });
        expect(acceptedClaim).not.toBeNull();
        if (!acceptedClaim) return;
        await expect(settleAutomationReplyHandoff({
            claim: acceptedClaim,
            now: positiveHintRetryAt,
            outcome: { kind: "accepted" },
            accountCurrentness: await readCurrentness(),
            receiptEnvelope: ACCEPTED_RECEIPT_ENVELOPE,
        })).resolves.toEqual({ applied: true });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "accepted",
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: JSON.stringify(ACCEPTED_RECEIPT_ENVELOPE),
        });
    });

    it("fails closed without blocking a ready handoff or retaining an immediate wake when E2EE Account currentness is inconsistent", async () => {
        await seedReadyHandoff();
        const binding = createSignedAccountContentBinding();
        await db.account.update({
            where: { id: ACCOUNT_ID },
            data: {
                encryptionMode: "e2ee",
                publicKey: binding.publicKey,
            },
        });

        await expect(findNextAutomationReplyHandoffDueAt({ now: NOW })).resolves.toBeNull();
        await expect(claimNextAutomationReplyHandoff({ now: NOW })).resolves.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                revision: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffAttempt: 0,
            revision: 0,
        });
    });

    it("skips an inconsistent earliest Account to claim the next eligible handoffs without exposing or mutating skipped bytes", async () => {
        const inconsistentAccountId = "account-reply-handoff-inconsistent-earliest";
        const inconsistentAutomationId = "automation-reply-handoff-inconsistent-earliest";
        const inconsistentRunId = "run-reply-handoff-ordering-invalid-00";
        const inconsistentHandoffId = "handoff-reply-handoff-ordering-invalid-00";
        const healthyAccountId = "account-reply-handoff-healthy-later";
        const healthyAutomationId = "automation-reply-handoff-healthy-later";
        const healthyRunId = "run-reply-handoff-ordering-tertiary-healthy";
        const healthyHandoffId = "handoff-reply-handoff-ordering-tertiary-healthy";
        const secondaryHealthyRunId = "run-reply-handoff-ordering-secondary-healthy";
        const secondaryHealthyHandoffId = "handoff-reply-handoff-ordering-secondary-healthy";
        const inconsistentDueAt = new Date(NOW.getTime() - 10_000);
        const tiedCreatedAt = new Date(inconsistentDueAt.getTime() + 1_000);
        const laterCreatedAt = new Date(tiedCreatedAt.getTime() + 1_000);
        const privateResultEnvelope = JSON.stringify({
            t: "encrypted",
            c: "private-inconsistent-handoff-result-sentinel",
        });
        const privateReplyContextEnvelope = JSON.stringify({
            t: "encrypted",
            c: "private-inconsistent-handoff-context-sentinel",
        });
        const createHealthyResultEnvelope = (runId: string, handoffId: string) => JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    accountId: healthyAccountId,
                    automationId: healthyAutomationId,
                    runId,
                    handoffId,
                },
                result: { v: 1, kind: "text", text: "Healthy result" },
            },
        });
        const createHealthyReplyContextEnvelope = (occurrenceKey: string) => JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    automationId: healthyAutomationId,
                    occurrenceKey,
                },
                templateVersion: 1,
                opaqueContext: {
                    conversationId: "healthy-conversation",
                    messageId: "healthy-message",
                },
            },
        });
        const healthyResultEnvelope = createHealthyResultEnvelope(healthyRunId, healthyHandoffId);
        const healthyOccurrenceKey = "B".repeat(43);
        const healthyReplyContextEnvelope = createHealthyReplyContextEnvelope(healthyOccurrenceKey);
        const secondaryHealthyResultEnvelope = createHealthyResultEnvelope(
            secondaryHealthyRunId,
            secondaryHealthyHandoffId,
        );
        const secondaryHealthyOccurrenceKey = "C".repeat(43);
        const secondaryHealthyReplyContextEnvelope = createHealthyReplyContextEnvelope(
            secondaryHealthyOccurrenceKey,
        );
        const binding = createSignedAccountContentBinding();
        await db.account.createMany({
            data: [
                {
                    id: inconsistentAccountId,
                    encryptionMode: "e2ee",
                    publicKey: binding.publicKey,
                },
                {
                    id: healthyAccountId,
                    encryptionMode: "plain",
                    publicKey: null,
                },
            ],
        });
        await db.automation.createMany({
            data: [
                {
                    id: inconsistentAutomationId,
                    accountId: inconsistentAccountId,
                    name: "Inconsistent earliest reply",
                    enabled: true,
                    targetType: "new_session",
                    templateCiphertext: JSON.stringify({
                        kind: "happier_automation_template_encrypted_v1",
                        payloadCiphertext: "private-inconsistent-template-sentinel",
                    }),
                    templateVersion: 1,
                    triggerKind: "schedule",
                    scheduleKind: "interval",
                    everyMs: 60_000,
                    triggerDefinitionEnvelope: null,
                },
                {
                    id: healthyAutomationId,
                    accountId: healthyAccountId,
                    name: "Healthy later reply",
                    enabled: true,
                    targetType: "new_session",
                    templateCiphertext: JSON.stringify({
                        kind: "happier_automation_template_plain_v1",
                        payload: { prompt: "healthy reply" },
                    }),
                    templateVersion: 1,
                    triggerKind: "schedule",
                    scheduleKind: "interval",
                    everyMs: 60_000,
                    triggerDefinitionEnvelope: null,
                },
            ],
        });
        // `invalid-31` fills the first 32-row page. The first healthy row
        // shares its due/creation values and is reachable only by `id`; once
        // leased, the later-created healthy row is reachable only by
        // `createdAt`.
        const inconsistentRuns = Array.from({ length: 33 }, (_, index) => {
            const orderingSuffix = String(index).padStart(2, "0");
            return {
                id: `run-reply-handoff-ordering-invalid-${orderingSuffix}`,
                automationId: inconsistentAutomationId,
                accountId: inconsistentAccountId,
                state: "succeeded" as const,
                originKind: "conversation" as const,
                originOccurredAt: inconsistentDueAt,
                occurrenceKey: `inconsistent-earliest-occurrence-${index}`,
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                resultEnvelope: privateResultEnvelope,
                replyContextEnvelope: privateReplyContextEnvelope,
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation/result-deliver-v1",
                replyHandoffTargetMachineId: "machine-inconsistent",
                replyHandoffTargetMachineInstallationId: "installation-inconsistent",
                replyHandoffTargetMaterializationId: "materialization-inconsistent",
                replyHandoffId: `handoff-reply-handoff-ordering-invalid-${orderingSuffix}`,
                replyHandoffState: "ready" as const,
                replyHandoffAttempt: 0,
                replyHandoffDueAt: inconsistentDueAt,
                scheduledAt: inconsistentDueAt,
                dueAt: inconsistentDueAt,
                finishedAt: inconsistentDueAt,
                createdAt: tiedCreatedAt,
            };
        });
        await db.automationRun.createMany({
            data: [
                ...inconsistentRuns,
                {
                    id: healthyRunId,
                    automationId: healthyAutomationId,
                    accountId: healthyAccountId,
                    state: "succeeded",
                    originKind: "conversation",
                    originOccurredAt: inconsistentDueAt,
                    occurrenceKey: healthyOccurrenceKey,
                    triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    resultEnvelope: healthyResultEnvelope,
                    replyContextEnvelope: healthyReplyContextEnvelope,
                    replyHandoffActionPluginId: "happier.channels",
                    replyHandoffActionLocalId: "automation/result-deliver-v1",
                    replyHandoffTargetMachineId: "machine-healthy",
                    replyHandoffTargetMachineInstallationId: "installation-healthy",
                    replyHandoffTargetMaterializationId: "materialization-healthy",
                    replyHandoffId: healthyHandoffId,
                    replyHandoffState: "ready",
                    replyHandoffAttempt: 0,
                    replyHandoffDueAt: inconsistentDueAt,
                    scheduledAt: inconsistentDueAt,
                    dueAt: inconsistentDueAt,
                    finishedAt: inconsistentDueAt,
                    createdAt: tiedCreatedAt,
                },
                {
                    id: secondaryHealthyRunId,
                    automationId: healthyAutomationId,
                    accountId: healthyAccountId,
                    state: "succeeded",
                    originKind: "conversation",
                    originOccurredAt: inconsistentDueAt,
                    occurrenceKey: secondaryHealthyOccurrenceKey,
                    triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    resultEnvelope: secondaryHealthyResultEnvelope,
                    replyContextEnvelope: secondaryHealthyReplyContextEnvelope,
                    replyHandoffActionPluginId: "happier.channels",
                    replyHandoffActionLocalId: "automation/result-deliver-v1",
                    replyHandoffTargetMachineId: "machine-healthy",
                    replyHandoffTargetMachineInstallationId: "installation-healthy",
                    replyHandoffTargetMaterializationId: "materialization-healthy",
                    replyHandoffId: secondaryHealthyHandoffId,
                    replyHandoffState: "ready",
                    replyHandoffAttempt: 0,
                    replyHandoffDueAt: inconsistentDueAt,
                    scheduledAt: inconsistentDueAt,
                    dueAt: inconsistentDueAt,
                    finishedAt: inconsistentDueAt,
                    createdAt: laterCreatedAt,
                },
            ],
        });

        const tertiaryClaim = await claimNextAutomationReplyHandoff({ now: NOW });

        expect(tertiaryClaim).toMatchObject({
            accountId: healthyAccountId,
            automationId: healthyAutomationId,
            runId: healthyRunId,
            handoffId: healthyHandoffId,
            occurrenceKey: healthyOccurrenceKey,
            attempt: 1,
            resultEnvelope: healthyResultEnvelope,
            replyContextEnvelope: healthyReplyContextEnvelope,
        });
        const secondaryClaim = await claimNextAutomationReplyHandoff({ now: NOW });

        expect(secondaryClaim).toMatchObject({
            accountId: healthyAccountId,
            automationId: healthyAutomationId,
            runId: secondaryHealthyRunId,
            handoffId: secondaryHealthyHandoffId,
            occurrenceKey: secondaryHealthyOccurrenceKey,
            attempt: 1,
            resultEnvelope: secondaryHealthyResultEnvelope,
            replyContextEnvelope: secondaryHealthyReplyContextEnvelope,
        });
        expect(JSON.stringify([tertiaryClaim, secondaryClaim]))
            .not.toContain("private-inconsistent-handoff");
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: inconsistentRunId },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
                revision: true,
                resultEnvelope: true,
                replyContextEnvelope: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffAttempt: 0,
            replyHandoffDueAt: inconsistentDueAt,
            revision: 0,
            resultEnvelope: privateResultEnvelope,
            replyContextEnvelope: privateReplyContextEnvelope,
        });
        const healthyAfter = await db.automationRun.findUniqueOrThrow({
            where: { id: healthyRunId },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
                revision: true,
            },
        });
        expect(healthyAfter).toMatchObject({
            replyHandoffState: "handingOff",
            replyHandoffAttempt: 1,
            revision: 1,
        });
        const secondaryHealthyAfter = await db.automationRun.findUniqueOrThrow({
            where: { id: secondaryHealthyRunId },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
                revision: true,
            },
        });
        expect(secondaryHealthyAfter).toMatchObject({
            replyHandoffState: "handingOff",
            replyHandoffAttempt: 1,
            revision: 1,
        });
        expect(secondaryHealthyAfter.replyHandoffDueAt).toEqual(healthyAfter.replyHandoffDueAt);
        await expect(findNextAutomationReplyHandoffDueAt({ now: NOW }))
            .resolves.toEqual(healthyAfter.replyHandoffDueAt);
    });

    it("fails closed without requeuing a claimed handoff when E2EE Account currentness becomes inconsistent", async () => {
        await seedReadyHandoff();
        const claim = await claimNextAutomationReplyHandoff({ now: NOW });
        expect(claim).not.toBeNull();
        if (!claim) return;

        const binding = createSignedAccountContentBinding();
        await db.account.update({
            where: { id: ACCOUNT_ID },
            data: {
                encryptionMode: "e2ee",
                publicKey: binding.publicKey,
            },
        });

        await expect(settleAutomationReplyHandoff({
            claim,
            now: NOW,
            outcome: { kind: "retry", retryAfterMs: 5_000 },
        })).resolves.toEqual({ applied: false });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                revision: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "handingOff",
            replyHandoffAttempt: 1,
            revision: 1,
        });
    });

    it("fences a stale settle and returns a retry to ready before the same handoff is re-claimed", async () => {
        await seedReadyHandoff();
        const claim = await claimNextAutomationReplyHandoff({ now: NOW });
        expect(claim).not.toBeNull();
        if (!claim) return;

        await expect(settleAutomationReplyHandoff({
            claim: { ...claim, attempt: claim.attempt - 1 },
            now: NOW,
            outcome: {
                kind: "retry",
                retryAfterMs: 5_000,
            },
        })).resolves.toEqual({ applied: false });

        await expect(settleAutomationReplyHandoff({
            claim,
            now: NOW,
            outcome: {
                kind: "retry",
                retryAfterMs: 5_000,
            },
        })).resolves.toEqual({ applied: true });
        await expect(findNextAutomationReplyHandoffDueAt({ now: NOW }))
            .resolves.toEqual(new Date(NOW.getTime() + 5_000));

        const reClaim = await claimNextAutomationReplyHandoff({
            now: new Date(NOW.getTime() + 5_000),
        });
        expect(reClaim).toMatchObject({ handoffId: HANDOFF_ID, attempt: 2 });

        await expect(settleAutomationReplyHandoff({
            claim: reClaim!,
            now: new Date(NOW.getTime() + 5_000),
            outcome: { kind: "accepted" },
            accountCurrentness: await readCurrentness(),
            receiptEnvelope: ACCEPTED_RECEIPT_ENVELOPE,
        })).resolves.toEqual({ applied: true });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "accepted",
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: JSON.stringify(ACCEPTED_RECEIPT_ENVELOPE),
        });
    });

    it("reclaims an expired handing-off attempt with the same stable handoff id", async () => {
        await seedReadyHandoff({
            state: "handingOff",
            attempt: 4,
            dueAt: new Date(NOW.getTime() - 1),
        });

        const claim = await claimNextAutomationReplyHandoff({ now: NOW });

        expect(claim).toMatchObject({
            handoffId: HANDOFF_ID,
            attempt: 5,
            resultEnvelope: RESULT_ENVELOPE,
            replyContextEnvelope: REPLY_CONTEXT_ENVELOPE,
        });
    });

    it("settles suppression terminally with its opaque receipt instead of retrying", async () => {
        await seedReadyHandoff();
        const claim = await claimNextAutomationReplyHandoff({ now: NOW });
        expect(claim).not.toBeNull();
        if (!claim) return;

        await expect(settleAutomationReplyHandoff({
            claim,
            now: NOW,
            outcome: { kind: "suppressed" },
            accountCurrentness: await readCurrentness(),
            receiptEnvelope: SUPPRESSED_RECEIPT_ENVELOPE,
        })).resolves.toEqual({ applied: true });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "suppressed",
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: JSON.stringify(SUPPRESSED_RECEIPT_ENVELOPE),
        });
    });

    it("returns a claim to ready without persisting a terminal receipt after Account currentness has moved", async () => {
        await seedReadyHandoff();
        const claim = await claimNextAutomationReplyHandoff({ now: NOW });
        expect(claim).not.toBeNull();
        if (!claim) return;

        const staleCurrentness = await readCurrentness();
        await db.account.update({
            where: { id: ACCOUNT_ID },
            data: { seq: { increment: 1 } },
        });

        await expect(settleAutomationReplyHandoff({
            claim,
            now: NOW,
            outcome: { kind: "accepted" },
            accountCurrentness: staleCurrentness,
            receiptEnvelope: ACCEPTED_RECEIPT_ENVELOPE,
        })).resolves.toEqual({ applied: true });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffDueAt: true, replyHandoffReceiptEnvelope: true },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffDueAt: NOW,
            replyHandoffReceiptEnvelope: null,
        });
    });

    it("returns a transformed claimed handoff to ready instead of terminally blocking newer Run bytes", async () => {
        await seedReadyHandoff();
        const claim = await claimNextAutomationReplyHandoff({ now: NOW });
        expect(claim).not.toBeNull();
        if (!claim) return;

        const transformedResultEnvelope = JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    accountId: ACCOUNT_ID,
                    automationId: AUTOMATION_ID,
                    runId: RUN_ID,
                    handoffId: HANDOFF_ID,
                },
                result: { v: 1, kind: "text", text: "Transformed result" },
            },
        });
        const transformedReplyContextEnvelope = JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    automationId: AUTOMATION_ID,
                    occurrenceKey: OCCURRENCE_KEY,
                },
                templateVersion: 1,
                opaqueContext: {
                    conversationId: "conversation-transformed",
                    messageId: "message-transformed",
                },
            },
        });
        await db.automationRun.update({
            where: { id: RUN_ID },
            data: {
                resultEnvelope: transformedResultEnvelope,
                replyContextEnvelope: transformedReplyContextEnvelope,
                revision: { increment: 1 },
                updatedAt: new Date(NOW.getTime() + 1),
            },
        });
        await db.account.update({
            where: { id: ACCOUNT_ID },
            data: { seq: { increment: 1 } },
        });

        await expect(settleAutomationReplyHandoff({
            claim,
            now: NOW,
            // This models a daemon that could not open the old claimed bytes
            // after the Account/Run transition and reported the fresh witness.
            outcome: { kind: "blocked" },
            accountCurrentness: await readCurrentness(),
        })).resolves.toEqual({ applied: true });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                resultEnvelope: true,
                replyContextEnvelope: true,
                replyHandoffState: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        })).resolves.toEqual({
            resultEnvelope: transformedResultEnvelope,
            replyContextEnvelope: transformedReplyContextEnvelope,
            replyHandoffState: "ready",
            replyHandoffDueAt: NOW,
            replyHandoffReceiptEnvelope: null,
        });
    });

    it("fails closed when stored handoff content no longer matches the Account mode", async () => {
        await seedReadyHandoff({
            resultEnvelope: JSON.stringify({ t: "encrypted", c: "opaque-ciphertext" }),
            receiptEnvelope: JSON.stringify(ACCEPTED_RECEIPT_ENVELOPE),
        });

        await expect(claimNextAutomationReplyHandoff({ now: NOW })).resolves.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "blocked",
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: null,
        });
    });
});
