import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from "@/app/automations/automationAccountCurrentness";
import { db, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { initializeWorkflowRunExecution } from "./workflowRunService";
import { cancelAutomationRun } from "@/app/automations/automationRunService";
import { encodeAutomationRunCause } from "@/app/automations/automationRunCauseCodec";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Workflow Run resource ordering", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("cancels a retained existing-session Run with its pending target audience admitted before the Run", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const viewer = await db.account.create({ data: { encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            metadata: "{}", encryptionMode: "plain", pendingCount: 1 } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: account.id,
            accountId: viewer.id, accessLevel: "view" } });
        const templateCiphertext = JSON.stringify({ kind: "happier_automation_template_plain_v1",
            payload: { prompt: "Run the retained automation", existingSessionId: session.id } });
        const automation = await db.automation.create({ data: { accountId: account.id, name: "Retained target",
            targetType: "existing_session", templateVersion: 1, templateCiphertext } });
        const invokedAt = Date.now();
        const run = await db.automationRun.create({ data: { accountId: account.id, automationId: automation.id,
            ...encodeAutomationRunCause({ kind: "manual", invokedAt }), state: "running", attempt: 1,
            scheduledAt: new Date(invokedAt), dueAt: new Date(invokedAt), startedAt: new Date(invokedAt),
            assignments: { create: { machineId: machine.id, priority: 0 } },
            executionInputEnvelope: JSON.stringify({ kind: "happier_automation_run_execution_input_v1",
                targetType: "existing_session", templateVersion: 1, templateCiphertext,
                origin: { kind: "manual", invokedAt } }) } });
        const localId = `automation:run:${run.id}`;
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId, messageRole: "user",
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "Automation pending input" } } },
            requestedAction: { v: 1, kind: "enqueue" }, status: "queued", deliveryState: "delivering", position: 1 } });
        const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        const transaction = db.$transaction;
        const locks: Array<{ kind: string; ids: unknown[] }> = [];
        let heldAtRun: typeof locks | undefined;
        let pid = 0;
        // Observe only the genuine database transport; cancellation, retained
        // recipe parsing, Session retirement and publication stay production-owned.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                pid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
                return callback(new Proxy(tx, { get(inner, key, innerReceiver) {
                    if (key !== "$queryRawUnsafe") return Reflect.get(inner, key, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        const result = await inner.$queryRawUnsafe(query, ...values);
                        if (query.includes("FOR ")) {
                            const kind = query.includes('FROM "AutomationRun"') ? "run"
                                : query.includes('FROM "Session"') ? "session"
                                    : query.includes('FROM "Account"') ? "account" : null;
                            if (kind === "run" && heldAtRun === undefined) heldAtRun = [...locks];
                            if (kind) locks.push({ kind, ids: values.flat() });
                        }
                        return result;
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const cancelled = await cancelAutomationRun({ accountId: account.id, runId: run.id })
                .then(value => ({ value }), error => ({ error }));
            console.info("Workflow retained target admission", JSON.stringify({ pid, maxRetries: 0, locks, heldAtRun }));
            console.info("Workflow retained target cancellation", cancelled);
            expect(cancelled).toMatchObject({ value: { id: run.id, state: "outcome_uncertain" } });
            expect(heldAtRun?.filter(lock => lock.kind === "account").flatMap(lock => lock.ids)).toContain(viewer.id);
            expect(heldAtRun?.filter(lock => lock.kind === "session").flatMap(lock => lock.ids)).toContain(session.id);
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } }))
                .toMatchObject({ status: "discarded", discardedReason: "session_input_cancelled" });
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).pendingCount).toBe(0);
            expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                accountId: viewer.id, kind: "session", entityId: session.id,
            } } })).toMatchObject({ entityId: session.id });
        } finally {
            db.$transaction = transaction;
            if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
        }
    });

    it("rejoins concurrent initialization without a Session resource or duplicate root error", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const run = await db.automationRun.create({ data: {
            accountId: account.id, originKind: "direct", causeKind: null, state: "queued", scheduledAt: new Date(), dueAt: new Date(),
            workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}", claimedByMachineId: machine.id,
            attempt: 1, assignments: { create: { machineId: machine.id, priority: 0 } },
        } });
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: account.id }, select: automationAccountCurrentnessSelect,
        }));
        if (!accountCurrentness) throw new Error("Fixture currentness unavailable");
        const rootId = randomUUID();
        const input = { accountId: account.id, runId: run.id, machineId: machine.id, parentAttempt: 1,
            expectedRevision: 0, accountCurrentness,
            checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "checkpoint", accountId: account.id, runId: run.id },
                checkpoint: { kind: "happier.workflow-checkpoint.v1", rootRecordId: rootId, nextSequence: "1",
                    frontier: { nextBlockOrdinal: 1, paused: false } },
            })),
            rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "invocation_progress", accountId: account.id, runId: run.id,
                    recordId: rootId, sequence: "0", parentRecordId: null, memberOrdinal: "0", attempt: "0" },
                progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: "$root", scope: [] },
                    blockKind: "root", attempt: "0", logicalInvocationRecordId: rootId },
            })) },
        };
        let release!: () => void;
        const mayContinue = new Promise<void>(resolve => { release = resolve; });
        let censusReady!: () => void;
        const firstCensus = new Promise<void>(resolve => { censusReady = resolve; });
        const original = db.$transaction.bind(db);
        let firstPid = 0;
        let secondPid = 0;
        let paused = false;
        const observed = async <T>(body: (tx: Tx) => Promise<T>, options?: Parameters<typeof original>[1]) => original(async tx => {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            if (firstPid === 0) firstPid = pid; else secondPid = pid;
            // Only the real DB transport pauses; all workflow decisions and
            // root-census results remain production-owned.
            const invocations = new Proxy(tx.workflowRunInvocation, { get(target, key, receiver) {
                if (key !== "count") return Reflect.get(target, key, receiver);
                return async (...args: Parameters<typeof target.count>) => {
                    const value = await target.count(...args);
                    if (!paused && pid === firstPid) {
                        paused = true;
                        censusReady();
                        await mayContinue;
                    }
                    return value;
                };
            } });
            return body(new Proxy(tx, { get(target, key, receiver) {
                return key === "workflowRunInvocation" ? invocations : Reflect.get(target, key, receiver);
            } }));
        }, options);
        db.$transaction = observed as typeof db.$transaction;
        let outcomes: Promise<PromiseSettledResult<Awaited<ReturnType<typeof initializeWorkflowRunExecution>>>[]> | undefined;
        try {
            const first = initializeWorkflowRunExecution(input);
            void first.catch(() => undefined);
            await Promise.race([firstCensus, first.then(() => { throw new Error("First initialization skipped root census"); })]);
            let secondSettled = false;
            const second = initializeWorkflowRunExecution(input).finally(() => { secondSettled = true; });
            outcomes = Promise.allSettled([first, second]);
            while (!secondSettled) {
                const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                    SELECT ${firstPid}::int = ANY(pg_blocking_pids(${secondPid}::int)) AS waiting
                `;
                if (waiting) break;
            }
            release();
            const results = await outcomes;
            for (const result of results) if (result.status === "rejected") throw result.reason;
            expect(results.map(result => result.status === "fulfilled" ? result.value.initialization : null).sort())
                .toEqual(["created", "existing"]);
            expect(await db.workflowRunInvocation.count({ where: { runId: run.id, parentRecordId: null } })).toBe(1);
            expect((await db.automationRun.findUniqueOrThrow({ where: { id: run.id } })).revision).toBe(1);
        } finally {
            release();
            await outcomes;
            db.$transaction = original;
            await db.automationRun.delete({ where: { id: run.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
