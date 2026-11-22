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
import { runAutomationReplyHandoffWorkerPass, startAutomationReplyHandoffWorker } from "./automationReplyHandoffWorker";

const ACCOUNT_ID = "account-reply-handoff-worker";
const AUTOMATION_ID = "automation-reply-handoff-worker";
const RUN_ID = "run-reply-handoff-worker";
const HANDOFF_ID = "handoff-reply-handoff-worker";
const OCCURRENCE_KEY = "A".repeat(43);
const NOW = new Date("2026-08-10T12:00:00.000Z");

function observeDeadlineClock() {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const timers = vi.spyOn(globalThis, "setTimeout");
    return {
        async waitForArm(count: number) { await vi.waitFor(() => expect(timers.mock.calls.filter(([, delay]) => typeof delay === "number" && (delay === 10_000 || delay > 500_000)).length).toBeGreaterThanOrEqual(count)); },
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

    it("does no idle scans and wakes for a committed retry before a future handoff deadline", async () => {
        await seedReadyHandoff();
        await db.automationRun.update({ where: { id: RUN_ID }, data: { replyHandoffDueAt: new Date(Date.now() + 600_000) } });
        const clock = observeDeadlineClock();
        let reads = 0;
        let dispatches = 0;
        const releaseIdle = observePrismaRequests(db, { before: request => {
            if (request.model === "AutomationRun" && request.action.startsWith("find")) reads += 1;
        } });
        const live = startAutomationReplyHandoffWorker({ dispatch: async () => {
            dispatches += 1;
            return { kind: "settled", settlement: { kind: "accepted" }, accountCurrentness: await readCurrentness() };
        } });
        try {
            await clock.waitForArm(1);
            const startupReads = reads;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads - startupReads).toBe(0);
            expect(dispatches).toBe(0);
            await db.automationRun.update({ where: { id: RUN_ID }, data: { replyHandoffState: "blocked" } });
            await retryBlockedAutomationReplyHandoff({ accountId: ACCOUNT_ID, runId: RUN_ID, now: new Date() });
            await vi.waitFor(() => expect(dispatches).toBe(1));
            await vi.waitFor(async () => expect(await db.automationRun.findUniqueOrThrow({ where: { id: RUN_ID }, select: { replyHandoffState: true } })).toEqual({ replyHandoffState: "accepted" }));
        } finally { await live.stop(); releaseIdle(); clock.close(); }
    });

    it("retains a committed wake that arrives while its initial database scan is in flight", async () => {
        await seedReadyHandoff();
        await db.automationRun.update({ where: { id: RUN_ID }, data: { replyHandoffState: "blocked" } });
        let scanStarted!: () => void;
        let releaseScan!: () => void;
        const started = new Promise<void>(resolve => { scanStarted = resolve; });
        const held = new Promise<void>(resolve => { releaseScan = resolve; });
        let holdFirstScan = true;
        const release = observePrismaRequests(db, { after: async request => {
            if (holdFirstScan && request.model === "AutomationRun" && request.action === "findMany") {
                holdFirstScan = false;
                scanStarted();
                await held;
            }
        } });
        let dispatches = 0;
        const worker = startAutomationReplyHandoffWorker({ dispatch: async () => {
            dispatches += 1;
            return { kind: "settled", settlement: { kind: "accepted" }, accountCurrentness: await readCurrentness() };
        } });
        try {
            await started;
            await retryBlockedAutomationReplyHandoff({ accountId: ACCOUNT_ID, runId: RUN_ID, now: new Date() });
            releaseScan();
            await vi.waitFor(() => expect(dispatches).toBe(1));
            await vi.waitFor(async () => expect(await db.automationRun.findUniqueOrThrow({ where: { id: RUN_ID },
                select: { replyHandoffState: true } })).toEqual({ replyHandoffState: "accepted" }));
        } finally { releaseScan(); await worker.stop(); release(); }
    });

    async function readCurrentness() {
        const account = await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        });
        expect(account.encryptionMode).toBe("plain");
        return { mode: "plain" as const, version: account.seq, contentKeyFingerprint: null };
    }

    it("reports database failures privately and retains one failure recovery wake", async () => {
        await seedReadyHandoff();
        await db.automationRun.update({ where: { id: RUN_ID }, data: { replyHandoffState: "blocked" } });
        const clock = observeDeadlineClock();
        const privateDetails = "private-prompt result-envelope account-secret";
        const warnings = vi.spyOn(logging, "warn").mockImplementation(() => {});
        let unavailable = true;
        const release = observePrismaRequests(db, { before: request => {
            if (unavailable && request.model === "AutomationRun" && request.action.startsWith("find")) {
                throw Object.assign(new Error(privateDetails), { code: "P1001" });
            }
        } });
        const worker = startAutomationReplyHandoffWorker({ dispatch: async () => ({ kind: "settled",
            settlement: { kind: "accepted" }, accountCurrentness: await readCurrentness() }) });
        try {
            await vi.waitFor(() => expect(warnings).toHaveBeenCalledWith(
                { module: "automation-reply-handoff-worker", operation: "pass",
                    failureCause: { phase: "automation.reply_handoff.pass", errorClass: "Error", errorCode: "P1001", httpStatus: null } }, expect.any(String)));
            await clock.waitForArm(1);
            unavailable = false;
            await db.automationRun.update({ where: { id: RUN_ID }, data: { replyHandoffState: "ready" } });
            await vi.advanceTimersByTimeAsync(10_000);
            await vi.waitFor(async () => expect(await db.automationRun.findUniqueOrThrow({ where: { id: RUN_ID },
                select: { replyHandoffState: true } })).toEqual({ replyHandoffState: "accepted" }));
            expect(JSON.stringify(warnings.mock.calls)).not.toContain(privateDetails);
        } finally { await worker.stop(); release(); warnings.mockRestore(); clock.close(); }
    });

    it.each(["throw", "unavailable", "malformed"] as const)("retains a private-safe %s cause beside the durable settlement", async (failure) => {
        await seedReadyHandoff();
        const privateDetails = "private reply envelope credential";
        const warnings = vi.spyOn(logging, "warn").mockImplementation(() => {});
        let dispatches = 0;
        try {
            await runAutomationReplyHandoffWorkerPass({ now: () => NOW, dispatch: async () => {
                dispatches += 1;
                if (failure === "throw") throw Object.assign(new Error(privateDetails), { code: "ECONNRESET" });
                if (failure === "unavailable") return { kind: "unavailable", code: "actionUnavailable" };
                return { kind: "settled", settlement: { kind: "accepted" }, privateDetails } as never;
            } });
            const code = failure === "throw" ? "targetUnavailable" : failure === "unavailable" ? "actionUnavailable" : "contractInvalid";
            expect(warnings).toHaveBeenCalledWith(expect.objectContaining({
                module: "automation-reply-handoff-worker", runId: RUN_ID, handoffId: HANDOFF_ID, code,
                ...(failure === "throw" ? { failureCause: { phase: "automation.reply_handoff.dispatch", errorClass: "Error", errorCode: "ECONNRESET", httpStatus: null } } : {}),
            }), expect.any(String));
            expect(JSON.stringify(warnings.mock.calls)).not.toContain(privateDetails);
            expect(dispatches).toBe(1);
            await expect(db.automationRun.findUniqueOrThrow({ where: { id: RUN_ID },
                select: { replyHandoffId: true, replyHandoffState: true } })).resolves.toEqual({
                replyHandoffId: HANDOFF_ID, replyHandoffState: failure === "unavailable" ? "blocked" : "ready",
            });
        } finally { warnings.mockRestore(); }
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

    it("recovers an expired dispatch at its persisted lease boundary with no idle fallback", async () => {
        await seedReadyHandoff();
        const clock = observeDeadlineClock();
        let dispatches = 0;
        const worker = startAutomationReplyHandoffWorker({ dispatch: async () => {
            dispatches += 1;
            if (dispatches === 1) {
                vi.setSystemTime(Date.now() + DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS + 1);
                return { kind: "unavailable", code: "contractInvalid" };
            }
            return { kind: "settled", settlement: { kind: "accepted" }, accountCurrentness: await readCurrentness() };
        } });
        try {
            await vi.waitFor(() => expect(dispatches).toBe(2));
            await vi.waitFor(async () => expect(await db.automationRun.findUniqueOrThrow({ where: { id: RUN_ID },
                select: { replyHandoffState: true, replyHandoffAttempt: true } })).toEqual({ replyHandoffState: "accepted", replyHandoffAttempt: 2 }));
        } finally { await worker.stop(); clock.close(); }
    });

    it("discovers a committed retry while an unrelated future retry is sleeping", async () => {
        await seedReadyHandoff();
        const retryAt = new Date(Date.now() + 600_000);
        const futureRun = await db.automationRun.update({
            where: { id: RUN_ID },
            data: { replyHandoffDueAt: retryAt, replyHandoffAttempt: 3 },
        });
        const clock = observeDeadlineClock();
        let deadlineReads = 0;
        const release = observePrismaRequests(db, { before: request => {
            if (request.model === "AutomationRun" && request.action === "findMany" && request.transactionId === undefined) {
                deadlineReads += 1;
            }
        } });
        const worker = startAutomationReplyHandoffWorker({
            dispatch: async () => ({
                kind: "settled",
                settlement: { kind: "accepted" },
                accountCurrentness: await readCurrentness(),
            }),
        });
        try {
            await clock.waitForArm(1);
            const startupDeadlineReads = deadlineReads;
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
                    replyHandoffState: "blocked",
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
            await retryBlockedAutomationReplyHandoff({ accountId: ACCOUNT_ID, runId, now: new Date() });
            await vi.waitFor(async () => {
                await expect(db.automationRun.findUniqueOrThrow({
                    where: { id: runId },
                    select: { replyHandoffState: true, replyHandoffAttempt: true },
                })).resolves.toEqual({ replyHandoffState: "accepted", replyHandoffAttempt: 1 });
            }, { timeout: 2_000, interval: 20 });
            await clock.waitForArm(2);
            expect(deadlineReads - startupDeadlineReads).toBe(2);
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: RUN_ID },
                select: { replyHandoffState: true, replyHandoffDueAt: true, replyHandoffAttempt: true },
            })).resolves.toEqual({ replyHandoffState: "ready", replyHandoffDueAt: retryAt, replyHandoffAttempt: 3 });
        } finally {
            await worker.stop();
            release();
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
