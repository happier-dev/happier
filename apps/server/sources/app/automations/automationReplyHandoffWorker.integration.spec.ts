import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AutomationReplyHandoffDispatchRequestV1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS,
    retryBlockedAutomationReplyHandoff,
} from "./automationReplyHandoffService";
import { runAutomationReplyHandoffWorkerPass, startAutomationReplyHandoffWorker } from "./automationReplyHandoffWorker";

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
                // Channel admission supplies the direct Conversation Run cause;
                // the reusable Automation needs no automatic trigger.
            },
        });
        await db.automationRun.create({
            data: {
                id: RUN_ID,
                automationId: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                state: "succeeded",
                triggerId: null,
                causeKind: "conversation",
                causeOccurredAt: NOW,
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

    it("discovers a newly ready handoff while an unrelated future retry is sleeping", async () => {
        await seedReadyHandoff();
        const retryAt = new Date(Date.now() + 60_000);
        const futureRun = await db.automationRun.update({
            where: { id: RUN_ID },
            data: { replyHandoffDueAt: retryAt, replyHandoffAttempt: 3 },
        });
        const idlePollMs = 100;
        const timers = vi.spyOn(globalThis, "setTimeout");
        const worker = startAutomationReplyHandoffWorker({
            idlePollMs,
            dispatch: async () => ({
                kind: "settled",
                settlement: { kind: "accepted" },
                accountCurrentness: await readCurrentness(),
            }),
        });
        try {
            // Observe the real worker entering its discovery sleep before the
            // database commit; no in-process wake or service mock rescues it.
            await vi.waitFor(() => expect(timers.mock.calls.some(([, delay]) => (
                delay === idlePollMs || (typeof delay === "number" && delay > 10_000)
            ))).toBe(true), { interval: 20 });
            const runId = `${RUN_ID}-new`;
            const handoffId = `${HANDOFF_ID}-new`;
            const occurrenceKey = `${"B".repeat(42)}A`;
            await db.automationRun.create({
                data: {
                    ...futureRun,
                    id: runId,
                    occurrenceKey,
                    replyHandoffId: handoffId,
                    replyHandoffDueAt: new Date(),
                    replyHandoffAttempt: 0,
                    resultEnvelope: JSON.stringify({
                        ...RESULT_ENVELOPE,
                        v: { ...RESULT_ENVELOPE.v, correspondence: {
                            ...RESULT_ENVELOPE.v.correspondence, runId, handoffId,
                        } },
                    }),
                    replyContextEnvelope: JSON.stringify({
                        ...REPLY_CONTEXT_ENVELOPE,
                        v: { ...REPLY_CONTEXT_ENVELOPE.v, correspondence: {
                            automationId: AUTOMATION_ID, occurrenceKey,
                        } },
                    }),
                },
            });
            await vi.waitFor(async () => {
                await expect(db.automationRun.findUniqueOrThrow({
                    where: { id: runId },
                    select: { replyHandoffState: true, replyHandoffAttempt: true },
                })).resolves.toEqual({ replyHandoffState: "accepted", replyHandoffAttempt: 1 });
            }, { timeout: 2_000, interval: 20 });
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: RUN_ID },
                select: { replyHandoffState: true, replyHandoffDueAt: true, replyHandoffAttempt: true },
            })).resolves.toEqual({ replyHandoffState: "ready", replyHandoffDueAt: retryAt, replyHandoffAttempt: 3 });
        } finally {
            await worker.stop();
            timers.mockRestore();
        }
    });

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
                cause: {
                    kind: "conversation",
                    occurrenceKey: OCCURRENCE_KEY,
                    occurredAt: NOW.getTime(),
                },
                accountCurrentness: claimedCurrentness,
                recipeKind: "legacy",
                resultEnvelope: RESULT_ENVELOPE,
                replyContextEnvelope: REPLY_CONTEXT_ENVELOPE,
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true },
        })).resolves.toEqual({
            replyHandoffState: "accepted",
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
            },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffAttempt: 1,
            replyHandoffDueAt: new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS),
        });
    });

    it("doubles the retry delay across consecutive unavailable attempts instead of repeating a fixed cadence", async () => {
        await seedReadyHandoff();
        const unavailableDispatch = async () =>
            ({ kind: "unavailable" as const, code: "targetUnavailable" as const });

        await runAutomationReplyHandoffWorkerPass({ now: NOW, dispatch: unavailableDispatch });
        const firstRetryAt = new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffAttempt: 1,
            replyHandoffDueAt: firstRetryAt,
        });

        await runAutomationReplyHandoffWorkerPass({ now: firstRetryAt, dispatch: unavailableDispatch });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffAttempt: 2,
            replyHandoffDueAt: new Date(
                firstRetryAt.getTime() + 2 * DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS,
            ),
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

    it("blocks a stable pre-effect invalid dispatch request instead of retrying immutable claim bytes", async () => {
        await seedReadyHandoff();

        await runAutomationReplyHandoffWorkerPass({
            now: NOW,
            dispatch: async () => ({ kind: "unavailable", code: "invalidRequest" }),
        });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffDueAt: true },
        })).resolves.toEqual({ replyHandoffState: "blocked", replyHandoffDueAt: null });
    });

    it("retries an Action execution failure because the target handler effect may be ambiguous", async () => {
        await seedReadyHandoff();

        await runAutomationReplyHandoffWorkerPass({
            now: NOW,
            dispatch: async () => ({ kind: "unavailable", code: "actionExecutionFailed" }),
        });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffDueAt: true },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffDueAt: new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS),
        });
    });

    it("retries an invalid matched-Action result because custody may already have committed", async () => {
        await seedReadyHandoff();

        await runAutomationReplyHandoffWorkerPass({
            now: NOW,
            dispatch: async () => ({ kind: "unavailable", code: "contractInvalid" }),
        });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffDueAt: true },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffDueAt: new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS),
        });
    });

    function dispatchedFrozenIdentity(request: AutomationReplyHandoffDispatchRequestV1) {
        // The durable custody obligation Channels dedupes by. `Account.seq`
        // advances with every claim/settlement publication, so the claim-time
        // currentness witness is deliberately excluded from this identity.
        return {
            handoffId: request.handoff.handoffId,
            runId: request.handoff.runId,
            automationId: request.handoff.automationId,
            occurrenceKey: request.handoff.occurrenceKey,
            cause: request.handoff.cause,
            resultEnvelope: request.handoff.resultEnvelope,
            replyContextEnvelope: request.handoff.replyContextEnvelope,
            target: request.target,
        };
    }

    it("moves contractInvalid custody through one retry, blocked custody, and manual reopen of the same handoff identity", async () => {
        await seedReadyHandoff();
        const dispatched: AutomationReplyHandoffDispatchRequestV1[] = [];
        const recordDispatch = () => async (request: unknown) => {
            dispatched.push(request as AutomationReplyHandoffDispatchRequestV1);
            return { kind: "unavailable" as const, code: "contractInvalid" as const };
        };
        const retryAt = new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS);
        const firstReopenAt = new Date(retryAt.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS);
        const secondReopenAt = new Date(firstReopenAt.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS);

        // First automatic attempt: the matched custody Action returned an
        // invalid result, so custody may already have committed. The ambiguity
        // budget schedules exactly one retry of the same durable handoff.
        await runAutomationReplyHandoffWorkerPass({ now: NOW, dispatch: recordDispatch() });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffAttempt: 1,
            replyHandoffDueAt: retryAt,
        });

        // Second absolute attempt: an invalid result cannot become valid
        // through unattended repetition, so the existing typed blocked custody
        // takes over.
        await runAutomationReplyHandoffWorkerPass({ now: retryAt, dispatch: recordDispatch() });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "blocked",
            replyHandoffAttempt: 2,
            replyHandoffDueAt: null,
        });

        // Present-user recovery reopens the same custody in place: identical
        // frozen identity, preserved absolute attempt budget.
        await expect(retryBlockedAutomationReplyHandoff({
            accountId: ACCOUNT_ID,
            runId: RUN_ID,
            now: firstReopenAt,
        })).resolves.toMatchObject({
            id: RUN_ID,
            replyHandoffState: "ready",
            replyHandoffDueAt: firstReopenAt,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffAttempt: true, replyHandoffId: true },
        })).resolves.toEqual({ replyHandoffAttempt: 2, replyHandoffId: HANDOFF_ID });

        // Absolute attempt semantics: the reopened custody receives exactly
        // one more dispatch, and a still-invalid result blocks again instead
        // of retry-looping.
        await runAutomationReplyHandoffWorkerPass({ now: firstReopenAt, dispatch: recordDispatch() });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffAttempt: true },
        })).resolves.toEqual({ replyHandoffState: "blocked", replyHandoffAttempt: 3 });

        // A deliberate manual retry that succeeds settles the same custody
        // through the ordinary accepted path.
        await expect(retryBlockedAutomationReplyHandoff({
            accountId: ACCOUNT_ID,
            runId: RUN_ID,
            now: secondReopenAt,
        })).resolves.toMatchObject({ id: RUN_ID, replyHandoffState: "ready" });
        await runAutomationReplyHandoffWorkerPass({
            now: secondReopenAt,
            dispatch: async (request) => {
                dispatched.push(request as AutomationReplyHandoffDispatchRequestV1);
                const accountCurrentness = await readCurrentness();
                return {
                    kind: "settled" as const,
                    settlement: { kind: "accepted" as const },
                    accountCurrentness,
                };
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffDueAt: true,
            },
        })).resolves.toMatchObject({
            replyHandoffState: "accepted",
            replyHandoffDueAt: null,
        });

        // Every dispatch rejoined the one durable custody obligation: the
        // frozen handoff identity never rotated and no second Run/queue row
        // was created.
        expect(dispatched).toHaveLength(4);
        const frozenIdentity = dispatchedFrozenIdentity(dispatched[0]!);
        for (const request of dispatched) {
            expect(dispatchedFrozenIdentity(request)).toEqual(frozenIdentity);
        }
        await expect(db.automationRun.count()).resolves.toBe(1);
    });

    it("blocks the second absolute attempt after a malformed dispatch response and reopens the same frozen identity", async () => {
        await seedReadyHandoff();
        const dispatched: AutomationReplyHandoffDispatchRequestV1[] = [];
        const retryAt = new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS);
        const reopenAt = new Date(retryAt.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS);

        await runAutomationReplyHandoffWorkerPass({
            now: NOW,
            dispatch: async (request) => {
                dispatched.push(request as AutomationReplyHandoffDispatchRequestV1);
                return { kind: "settled", settlement: { kind: "accepted" } } as never;
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffAttempt: 1,
            replyHandoffDueAt: retryAt,
        });

        await runAutomationReplyHandoffWorkerPass({
            now: retryAt,
            dispatch: async (request) => {
                dispatched.push(request as AutomationReplyHandoffDispatchRequestV1);
                return { kind: "settled", settlement: { kind: "accepted" } } as never;
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
            },
        })).resolves.toEqual({
            replyHandoffState: "blocked",
            replyHandoffAttempt: 2,
            replyHandoffDueAt: null,
        });

        await expect(retryBlockedAutomationReplyHandoff({
            accountId: ACCOUNT_ID,
            runId: RUN_ID,
            now: reopenAt,
        })).resolves.toMatchObject({ id: RUN_ID, replyHandoffState: "ready" });
        await runAutomationReplyHandoffWorkerPass({
            now: reopenAt,
            dispatch: async (request) => {
                dispatched.push(request as AutomationReplyHandoffDispatchRequestV1);
                const accountCurrentness = await readCurrentness();
                return {
                    kind: "settled" as const,
                    settlement: { kind: "accepted" as const },
                    accountCurrentness,
                };
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: {
                replyHandoffState: true,
                replyHandoffDueAt: true,
            },
        })).resolves.toMatchObject({
            replyHandoffState: "accepted",
            replyHandoffDueAt: null,
        });

        expect(dispatched).toHaveLength(3);
        const frozenIdentity = dispatchedFrozenIdentity(dispatched[0]!);
        for (const request of dispatched) {
            expect(dispatchedFrozenIdentity(request)).toEqual(frozenIdentity);
        }
        await expect(db.automationRun.count()).resolves.toBe(1);
    });

});
