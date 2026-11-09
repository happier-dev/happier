import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AutomationReplyHandoffDispatchRequestV1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createDatabaseIntegrationHarness } from "@/testkit/databaseIntegrationHarness";
import { observePrismaRequests } from "@/testkit/observeSqliteRequests";
import * as logging from "@/utils/logging/log";

import {
    DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS,
    retryBlockedAutomationReplyHandoff,
} from "./automationReplyHandoffService";
import { DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS, runAutomationReplyHandoffWorkerPass, startAutomationReplyHandoffWorker } from "./automationReplyHandoffWorker";

const ACCOUNT_ID = "account-reply-handoff-worker";
const AUTOMATION_ID = "automation-reply-handoff-worker";
const RUN_ID = "run-reply-handoff-worker";
const HANDOFF_ID = "handoff-reply-handoff-worker";
const OCCURRENCE_KEY = "A".repeat(43);
const NOW = new Date("2026-08-10T12:00:00.000Z");

function observeFallbackClock() {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const setTimeoutAtBoundary = globalThis.setTimeout;
    let fires = 0;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
        setTimeoutAtBoundary(() => {
            if (delay === DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS) fires += 1;
            callback(...args);
        }, delay));
    return {
        get fires() { return fires; },
        get arms() { return timers.mock.calls.filter(([, delay]) => delay === DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS).length; },
        async waitForArm(count: number) {
            await vi.waitFor(() => expect(timers.mock.calls.filter(([, delay]) => delay === DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS).length).toBeGreaterThanOrEqual(count));
        },
        close() { timers.mockRestore(); vi.useRealTimers(); },
    };
}

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
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>> | undefined;

    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({
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

    it("keeps one existing fallback scan for cross-API writes and database-only recovery while honoring a future reply deadline", async () => {
        await seedReadyHandoff();
        const futureDueAt = new Date(Date.now() + 600_000);
        await db.automationRun.update({ where: { id: RUN_ID }, data: { replyHandoffDueAt: futureDueAt } });
        const clock = observeFallbackClock();
        let reads = 0;
        let transactions = 0;
        const originalTransaction = db.$transaction;
        db.$transaction = new Proxy(originalTransaction, {
            apply(transaction, receiver, args: unknown[]) {
                transactions += 1;
                return Reflect.apply(transaction, receiver, args);
            },
        });
        const release = observePrismaRequests(db, { before: request => {
            if (request.model === "AutomationRun" && request.action.startsWith("find")) reads += 1;
        } });
        const worker = startAutomationReplyHandoffWorker({ dispatch: async () => {
            throw new Error("The future handoff must not dispatch before its own deadline");
        } });
        try {
            await clock.waitForArm(1);
            expect(reads).toBe(1);
            expect(transactions).toBe(0);
            const startupReads = reads;
            for (let wake = 1; wake <= 6; wake += 1) {
                await vi.advanceTimersByTimeAsync(DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS);
                await clock.waitForArm(wake + 1);
                expect(clock.fires).toBe(wake);
            }
            expect(reads - startupReads).toBe(6);
            expect(transactions).toBe(0);
            await expect(db.automationRun.findUniqueOrThrow({ where: { id: RUN_ID },
                select: { replyHandoffDueAt: true, replyHandoffAttempt: true } }))
                .resolves.toEqual({ replyHandoffDueAt: futureDueAt, replyHandoffAttempt: 0 });
            await worker.stop();
            const stoppedReads = reads;
            await vi.advanceTimersByTimeAsync(DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS);
            expect(clock.fires).toBe(6);
            expect(reads).toBe(stoppedReads);
        } finally {
            await worker.stop();
            release();
            db.$transaction = originalTransaction;
            clock.close();
        }
    });

    async function readCurrentness() {
        const account = await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        });
        expect(account.encryptionMode).toBe("plain");
        return { mode: "plain" as const, version: account.seq, contentKeyFingerprint: null };
    }

    it("reports real database failures privately and recovers through the existing fallback without reconnect or push", async () => {
        await seedReadyHandoff();
        const clock = observeFallbackClock();
        const privateDetails = "private-prompt result-envelope account-secret";
        const warnings = vi.spyOn(logging, "warn").mockImplementation(() => {});
        let unavailable = true;
        const release = observePrismaRequests(db, { before: request => {
            if (unavailable && request.model === "AutomationRun" && request.action.startsWith("find")) throw new Error(privateDetails);
        } });
        const worker = startAutomationReplyHandoffWorker({ dispatch: async () => ({ kind: "settled",
            settlement: { kind: "accepted" }, accountCurrentness: await readCurrentness() }) });
        try {
            await vi.waitFor(() => {
                expect(warnings).toHaveBeenCalledWith({ module: "automation-reply-handoff-worker", operation: "pass" }, expect.any(String));
                expect(warnings).toHaveBeenCalledWith({ module: "automation-reply-handoff-worker", operation: "due-scan" }, expect.any(String));
            });
            await clock.waitForArm(1);
            unavailable = false;
            await vi.advanceTimersByTimeAsync(DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS);
            await vi.waitFor(async () => expect(await db.automationRun.findUniqueOrThrow({ where: { id: RUN_ID },
                select: { replyHandoffState: true, replyHandoffAttempt: true } }))
                .toEqual({ replyHandoffState: "accepted", replyHandoffAttempt: 1 }));
            expect(JSON.stringify(warnings.mock.calls)).not.toContain(privateDetails);
        } finally {
            await worker.stop();
            release();
            warnings.mockRestore();
            clock.close();
        }
    });

    it.each([0, 1_234])("settles a late RPC retry hint %i at the response clock while retaining the same high-attempt handoff", async (retryAfterMs) => {
        await seedReadyHandoff();
        await db.automationRun.update({ where: { id: RUN_ID }, data: { replyHandoffAttempt: 2 } });
        let clock = NOW;
        const responseAt = new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS + 5_000);
        await runAutomationReplyHandoffWorkerPass({
            now: () => clock,
            dispatch: async () => {
                clock = responseAt;
                return { kind: "settled", settlement: { kind: "retry", retryAfterMs }, accountCurrentness: await readCurrentness() };
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({ where: { id: RUN_ID },
            select: { replyHandoffId: true, replyHandoffAttempt: true, replyHandoffState: true, replyHandoffDueAt: true } }))
            .resolves.toEqual({ replyHandoffId: HANDOFF_ID, replyHandoffAttempt: 3, replyHandoffState: "ready",
                replyHandoffDueAt: retryAfterMs > 0 ? new Date(responseAt.getTime() + retryAfterMs)
                    : new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS) });
    });

    it("retries a late expired handoff through the existing fallback without an immediate self-wake or attempt ceiling", async () => {
        await seedReadyHandoff();
        await db.automationRun.update({ where: { id: RUN_ID }, data: { replyHandoffAttempt: 2 } });
        const clock = observeFallbackClock();
        let dispatches = 0;
        const worker = startAutomationReplyHandoffWorker({ dispatch: async (raw) => {
            const request = raw as AutomationReplyHandoffDispatchRequestV1;
            expect(request.handoff.handoffId).toBe(HANDOFF_ID);
            dispatches += 1;
            if (dispatches === 1) vi.setSystemTime(Date.now() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS + 1);
            return { kind: "unavailable", code: "contractInvalid" };
        } });
        try {
            await clock.waitForArm(1);
            expect(dispatches).toBe(1);
            await vi.advanceTimersByTimeAsync(0);
            expect(dispatches).toBe(1);
            await vi.advanceTimersByTimeAsync(DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS);
            await clock.waitForArm(2);
            expect(dispatches).toBe(2);
            await vi.advanceTimersByTimeAsync(DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS);
            await clock.waitForArm(3);
            expect(clock.fires).toBe(2);
            expect(dispatches).toBe(2);
            await expect(db.automationRun.findUniqueOrThrow({ where: { id: RUN_ID },
                select: { replyHandoffState: true, replyHandoffAttempt: true, replyHandoffId: true } }))
                .resolves.toEqual({ replyHandoffState: "ready", replyHandoffAttempt: 4, replyHandoffId: HANDOFF_ID });
            await expect(db.automationRun.count()).resolves.toBe(1);
        } finally {
            await worker.stop();
            clock.close();
        }
    });

    it("discovers a cross-API ready handoff without a push while an unrelated future retry is sleeping", async () => {
        await seedReadyHandoff();
        const retryAt = new Date(Date.now() + 60_000);
        const futureRun = await db.automationRun.update({
            where: { id: RUN_ID },
            data: { replyHandoffDueAt: retryAt, replyHandoffAttempt: 3 },
        });
        const clock = observeFallbackClock();
        const worker = startAutomationReplyHandoffWorker({
            dispatch: async () => ({
                kind: "settled",
                settlement: { kind: "accepted" },
                accountCurrentness: await readCurrentness(),
            }),
        });
        try {
            await clock.waitForArm(1);
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
            await vi.advanceTimersByTimeAsync(DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS);
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
            clock.close();
        }
    });

    it("routes only the frozen target and opaque stored envelopes, then persists accepted custody", async () => {
        await seedReadyHandoff();
        const claimedCurrentness = await readCurrentness();
        let dispatched: unknown = null;

        await runAutomationReplyHandoffWorkerPass({
            now: () => NOW,
            dispatch: async (request) => {
                dispatched = request;
                const accountCurrentness = await readCurrentness();
                return {
                    kind: "settled",
                    settlement: { kind: "accepted" },
                    accountCurrentness,
                };
            },
        });

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
            now: () => NOW,
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
            replyHandoffDueAt: new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS),
        });
    });

    it("reuses each exact claim expiry across consecutive unavailable attempts without a retry backoff", async () => {
        await seedReadyHandoff();
        const unavailableDispatch = async () =>
            ({ kind: "unavailable" as const, code: "targetUnavailable" as const });

        await runAutomationReplyHandoffWorkerPass({ now: () => NOW, dispatch: unavailableDispatch });
        const firstRetryAt = new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS);
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

        await runAutomationReplyHandoffWorkerPass({ now: () => firstRetryAt, dispatch: unavailableDispatch });
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
                firstRetryAt.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS,
            ),
        });
    });

    it("makes an unavailable Action durable attention instead of retrying a contract failure", async () => {
        await seedReadyHandoff();

        await runAutomationReplyHandoffWorkerPass({
            now: () => NOW,
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
            now: () => NOW,
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
            now: () => NOW,
            dispatch: async () => ({ kind: "unavailable", code: "actionExecutionFailed" }),
        });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffDueAt: true },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffDueAt: new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS),
        });
    });

    it("retries an invalid matched-Action result because custody may already have committed", async () => {
        await seedReadyHandoff();

        await runAutomationReplyHandoffWorkerPass({
            now: () => NOW,
            dispatch: async () => ({ kind: "unavailable", code: "contractInvalid" }),
        });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: RUN_ID },
            select: { replyHandoffState: true, replyHandoffDueAt: true },
        })).resolves.toEqual({
            replyHandoffState: "ready",
            replyHandoffDueAt: new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS),
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


    it("rejoins repeated malformed dispatch responses without changing the frozen identity", async () => {
        await seedReadyHandoff();
        const dispatched: AutomationReplyHandoffDispatchRequestV1[] = [];
        const retryAt = new Date(NOW.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS);
        const reopenAt = new Date(retryAt.getTime() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS);

        await runAutomationReplyHandoffWorkerPass({
            now: () => NOW,
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
            now: () => retryAt,
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
            replyHandoffAttempt: 2,
            replyHandoffDueAt: reopenAt,
        });

        await expect(retryBlockedAutomationReplyHandoff({
            accountId: ACCOUNT_ID,
            runId: RUN_ID,
            now: reopenAt,
        })).resolves.toMatchObject({ id: RUN_ID, replyHandoffState: "ready" });
        await runAutomationReplyHandoffWorkerPass({
            now: () => reopenAt,
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
