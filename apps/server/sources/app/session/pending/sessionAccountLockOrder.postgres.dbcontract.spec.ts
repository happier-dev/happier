import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { fenceExactCurrentPublisherAuthorityInTx } from "./hasExactCurrentPublisherAuthorityInTx";
import { armPendingActivationAuthorizationInTx } from "./pendingActivationAuthorization";
import { inPendingQueuePositionTx } from "./reserveNextPendingQueuePosition";
import { setEligibleMachineAccessGrantInTx as setMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { revokeMachineInTx } from "@/app/machines/machineMutations";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { enqueuePendingMessage } from "./pendingMessageService";
import { withWebLatencyTrace } from "@/utils/webLatencyTrace";
import { logger } from "@/utils/logging/log";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { SessionTurnMutationReceiptV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent,
} from "@happier-dev/protocol";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Session and Account lock order", () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing disposable PostgreSQL contract DATABASE_URL");
        vi.stubEnv("HAPPIER_WEB_LATENCY_TRACE", "1");
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    it('serializes turn annotations and completion at the Session before reserving their durable receipts', async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const authentication = { env: process.env, authority: "present_user" as const, authenticationEvidence: [] };
        const turnId = randomUUID();
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
            v: 1, sessionId: session.id, mutationId: randomUUID(), action: "begin", turnId, observedAt: 1,
        } })).toMatchObject({ ok: true, didApply: true });
        const pending: Array<ReturnType<typeof applySessionTurnMutation>> = [];
        let settled = 0;
        try {
            await db.$transaction(async peer => {
                const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await peer.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${session.id} FOR NO KEY UPDATE`;
                for (const action of ["attach_agent_turn_id", "complete"] as const) {
                    const request = applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
                        v: 1, sessionId: session.id, mutationId: randomUUID(), action, turnId, observedAt: 2,
                        ...(action === "attach_agent_turn_id" ? { agentTurnId: "native-turn" } : {}),
                    } }).finally(() => { settled++; });
                    void request.catch(() => undefined);
                    pending.push(request);
                }
                let sessionWaiters = 0;
                while (settled === 0 && sessionWaiters < 2) {
                    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
                        WITH RECURSIVE blocked AS (
                            SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                                AND ${pid} = ANY(pg_blocking_pids(pid))
                            UNION
                            SELECT activity.pid FROM pg_stat_activity activity JOIN blocked
                                ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
                        )
                        SELECT COUNT(*) AS count FROM pg_stat_activity WHERE pid IN (SELECT pid FROM blocked)
                            AND query LIKE '%SELECT "id" FROM "Session" WHERE%FOR NO KEY UPDATE%'
                    `;
                    sessionWaiters = Number(count);
                }
                expect(settled).toBe(0);
                expect(sessionWaiters).toBe(2);
                expect(await peer.sessionTurnMutationReceipt.count({ where: { sessionId: session.id } })).toBe(1);
            });
            for (const result of await Promise.all(pending)) expect(result).toMatchObject({ ok: true });
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).latestTurnStatus).toBe("completed");
            expect(await db.sessionTurnMutationReceipt.count({ where: { sessionId: session.id } })).toBe(3);
        } finally {
            await Promise.allSettled(pending);
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["attach_agent_turn_id", "append_transcript_anchors"] as const)("persists %s and its strict receipt without waiting for an unrelated Account cursor writer", async action => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const authentication = { env: process.env, authority: "present_user" as const, authenticationEvidence: [] };
        const turnId = randomUUID();
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
            v: 1, sessionId: session.id, mutationId: randomUUID(), action: "begin", turnId, observedAt: 1,
        } })).toMatchObject({ ok: true, didApply: true });
        const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        const beforeCursor = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
        const transcriptAnchors = { startSeqInclusive: 1, endSeqInclusive: 2 };
        const mutation = { v: 1, sessionId: session.id, mutationId: randomUUID(), turnId, observedAt: 2, action,
            ...(action === "attach_agent_turn_id" ? { agentTurnId: "native-turn" } : { transcriptAnchors }) };
        let pending: ReturnType<typeof applySessionTurnMutation> | undefined;
        let completed = false;
        let blocked = false;
        try {
            await db.$transaction(async peer => {
                const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await peer.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                pending = applySessionTurnMutation({ actorUserId: account.id, authentication, mutation })
                    .finally(() => { completed = true; });
                void pending.catch(() => undefined);
                while (!completed) {
                    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                            AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                    `;
                    if (waiting) { blocked = true; break; }
                }
            });
            const result = await pending;
            expect(result).toMatchObject({ ok: true, didApply: true, recipientCursors: [] });
            if (!result?.ok) throw new Error("Expected annotation result");
            expect(SessionTurnMutationReceiptV1Schema.parse(result.receipt)).toMatchObject({
                action, mutationId: mutation.mutationId, decision: "applied", turnId,
            });
            expect(blocked, "Turn-only annotations publish no Account cursor").toBe(false);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(before);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(beforeCursor + 1);
            const turn = await db.sessionTurn.findUniqueOrThrow({ where: { sessionId_turnId: { sessionId: session.id, turnId } } });
            if (action === "attach_agent_turn_id") expect(turn.agentTurnId).toBe("native-turn");
            else expect(JSON.parse(turn.transcriptAnchorsJson!)).toMatchObject(transcriptAnchors);
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation }))
                .toMatchObject({ ok: true, didApply: false, receipt: result.receipt });
            await db.account.update({ where: { id: account.id }, data: { status: "suspended" } });
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
                mutation: { ...mutation, mutationId: randomUUID() } })).toMatchObject({ ok: false, error: "forbidden" });
            expect(await db.sessionTurnMutationReceipt.count({ where: { sessionId: session.id } })).toBe(2);
        } finally {
            await pending;
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("joins real Account-lock waiters to their query spans and transaction outcomes", async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        vi.stubEnv("HAPPIER_WEB_LATENCY_TRACE", "1");
        const previousLevel = logger.level;
        logger.level = "trace";
        const sink = vi.spyOn(logger, "trace").mockImplementation(() => undefined);
        const failureSink = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
        const account = await db.account.create({ data: createSignedAccountContentBinding() });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const requestId = randomUUID();
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const locked = new Promise<number>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            ready(pid);
            await released;
        });
        const writerOutcome = Promise.allSettled([writer]);
        let pendingOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
            const writerPid = await locked;
            const pending = withWebLatencyTrace(requestId, () => inTx(async tx => {
                await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
                return markAccountChanged(tx, { accountId: account.id, kind: "session", entityId: session.id });
            }));
            pendingOutcome = Promise.allSettled([pending]);
            let waiter: { pid: number; query: string } | undefined;
            // Observe the actual PostgreSQL lock, not an intercepted domain call.
            await vi.waitFor(async () => {
                const rows = await db.$queryRaw<Array<{ pid: number; query: string }>>`
                    SELECT pid, query FROM pg_stat_activity WHERE ${writerPid}::int = ANY(pg_blocking_pids(pid))
                `;
                waiter = rows.find(row => row.query.includes('FROM "Account"'));
                expect(waiter).toBeDefined();
            }, { timeout: 1_000 });
            expect(waiter?.query).toContain(`/* happier-web-latency:${requestId}:`);
            const spanId = Number(/happier-web-latency:[a-z0-9-]+:(\d+)/u.exec(waiter!.query)?.[1]);
            expect(Number.isSafeInteger(spanId)).toBe(true);
            release();
            for (const outcome of [...await writerOutcome, ...await pendingOutcome]) {
                if (outcome.status === "rejected") throw outcome.reason;
            }
            const records = sink.mock.calls.map(([record]) => record).filter(
                (record): record is Record<string, unknown> => typeof record === "object" && record !== null,
            );
            const query = records.find(record => record.requestId === requestId && record.spanId === spanId);
            expect(query).toMatchObject({ phase: "db.raw.$queryRawUnsafe", status: "completed", parentSpanId: expect.any(Number) });
            expect(records).toContainEqual(expect.objectContaining({ requestId, phase: "db.transaction.attempt", status: "completed" }));

            const failedRequestId = randomUUID();
            await expect(withWebLatencyTrace(failedRequestId, () => inTx(tx => tx.$queryRawUnsafe(
                "SELECT 1 / 0 /* private-database-input */",
            )))).rejects.toBeDefined();
            expect(failureSink.mock.calls.map(([record]) => record)).toContainEqual(expect.objectContaining({
                requestId: failedRequestId, phase: "db.transaction.attempt", status: "failed", code: "P2010", sqlState: "22012",
            }));
            const traceRecords = [...sink.mock.calls, ...failureSink.mock.calls].map(([record]) => record).filter(record => typeof record === "object" && record !== null && "phase" in record);
            expect(JSON.stringify(traceRecords)).not.toContain("private-database-input");
            vi.stubEnv("HAPPIER_WEB_LATENCY_TRACE", "0");
            const sql = "SELECT current_query() AS query";
            await expect(withWebLatencyTrace(randomUUID(), () => db.$queryRawUnsafe(sql))).resolves.toEqual([{ query: sql }]);
        } finally {
            release();
            await Promise.all([writerOutcome, pendingOutcome]);
            sink.mockRestore();
            failureSink.mockRestore();
            logger.level = previousLevel;
            vi.unstubAllEnvs();
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("reads publisher authority without waiting for an unrelated Account cursor writer", async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        const account = await db.account.create({ data: createSignedAccountContentBinding() });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: "{}",
        } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}",
        } });
        await db.accessKey.create({ data: {
            accountId: account.id, machineId: machine.id, sessionId: session.id, data: "encrypted",
        } });
        const presence = createSessionPublisherPresence();
        const socket = {};
        const registered = await presence.registerPublisher({ socket,
            binding: { accountId: account.id, machineId: machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: "unknown", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let locked!: () => void;
        const ready = new Promise<void>(resolve => { locked = resolve; });
        const writer = inTx(async tx => {
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            locked();
            await released;
        });
        await ready;
        let observed: Awaited<ReturnType<typeof presence.readCurrentPublisherPrecondition>> | undefined;
        const read = presence.readCurrentPublisherPrecondition({ socket }).then(value => { observed = value; });
        try {
            await vi.waitFor(() => expect(observed).toEqual({
                machineId: machine.id,
                committedFenceMs: registered.committedFence.getTime(),
                publisherGeneration: registered.publisherGeneration.toString(),
            }), { timeout: 1_000 });
        } finally {
            release();
            await Promise.all([writer, read]);
            await db.accessKey.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("acknowledges unchanged publisher Activity without waiting for an unrelated Account cursor writer", async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        const account = await db.account.create({ data: createSignedAccountContentBinding() });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: "{}",
        } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}",
        } });
        await db.accessKey.create({ data: {
            accountId: account.id, machineId: machine.id, sessionId: session.id, data: "encrypted",
        } });
        const presence = createSessionPublisherPresence();
        const socket = {};
        const binding = { accountId: account.id, machineId: machine.id, sessionId: session.id };
        const registered = await presence.registerPublisher({ socket, binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const before = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
            runtimeActivityRevision: true, runtimeActivityObservedAt: true, updatedAt: true,
        } });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let locked!: () => void;
        const ready = new Promise<void>(resolve => { locked = resolve; });
        const writer = inTx(async tx => {
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            locked();
            await released;
        });
        await ready;
        let observed: Awaited<ReturnType<typeof presence.publishSnapshot>> | undefined;
        const snapshot = presence.publishSnapshot({ socket, binding,
            completeSnapshot: { state: "idle", activeCount: 0 },
        }).then(value => { observed = value; return value; });
        try {
            await vi.waitFor(() => expect(observed).toMatchObject({
                status: "unchanged", recipientCursors: [], projection: {
                    runtimeActivityState: "idle", runtimeActivityActiveCount: 0,
                    runtimeActivityRevision: Number(before.runtimeActivityRevision),
                    runtimeActivityObservedAt: Number(before.runtimeActivityObservedAt),
                },
            }), { timeout: 1_000 });
            release();
            await writer;
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                runtimeActivityRevision: true, runtimeActivityObservedAt: true, updatedAt: true,
            } })).toEqual(before);
            expect(await inTx(tx => revokeMachineInTx(tx, { accountId: account.id, machineId: machine.id })))
                .toMatchObject({ ok: true });
            await expect(presence.publishSnapshot({ socket, binding,
                completeSnapshot: { state: "idle", activeCount: 0 },
            })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        } finally {
            release();
            await Promise.all([writer, snapshot]);
            await db.accessKey.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["cursor", "revoked", "superseded"] as const)("admits publisher Activity after the Account fence settles a concurrent %s write", async change => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        const account = await db.account.create({ data: createSignedAccountContentBinding() });
        const transaction = db.$transaction.bind(db);
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let writerOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
        let activityOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: account.id, metadata: "{}",
            } });
            const session = await db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: "{}",
            } });
            await db.accessKey.create({ data: {
                accountId: account.id, machineId: machine.id, sessionId: session.id, data: "encrypted",
            } });
            const presence = createSessionPublisherPresence();
            const socket = {};
            const binding = { accountId: account.id, machineId: machine.id, sessionId: session.id };
            expect(await presence.registerPublisher({ socket, binding,
                completeActivitySnapshot: { state: "unknown", activeCount: 0 },
            })).toMatchObject({ status: "registered" });
            const before = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                runtimeActivityRevision: true, lastActiveAt: true, updatedAt: true,
            } });
            vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
            let writerReady!: (pid: number) => void;
            const ready = new Promise<number>(resolve => { writerReady = resolve; });
            // Hold the real writer immediately before commit, including a
            // replacement through the same production registration owner.
            const holdWriter = async <T>(fn: (tx: Tx) => Promise<T>, options?: Parameters<typeof transaction>[1]) =>
                transaction(async tx => {
                    const result = await fn(tx);
                    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    writerReady(pid);
                    await released;
                    return result;
                }, options);
            db.$transaction = holdWriter as typeof db.$transaction;
            const writer = change === "superseded"
                ? presence.registerPublisher({ socket: {}, binding,
                    completeActivitySnapshot: { state: "unknown", activeCount: 0 },
                }).then(result => { expect(result).toMatchObject({ status: "registered" }); })
                : inTx(async tx => {
                    await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
                    if (change === "revoked") {
                        expect(await revokeMachineInTx(tx, { accountId: account.id, machineId: machine.id }))
                            .toMatchObject({ ok: true });
                    } else {
                        await markAccountChanged(tx, { accountId: account.id, kind: "account", entityId: account.id });
                    }
                });
            writerOutcome = Promise.allSettled([writer]);
            const writerPid = await Promise.race([ready, writer.then(() => { throw new Error("Writer ended before locking Account"); })]);
            let activityPid = -1;
            // Intercept only the database transport to identify the real waiting
            // transaction. Preserve its production isolation and all domain logic.
            const identify = async <T>(fn: (tx: Tx) => Promise<T>, options?: Parameters<typeof transaction>[1]) =>
                transaction(async tx => {
                    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    activityPid = pid;
                    return fn(tx);
                }, options);
            db.$transaction = identify as typeof db.$transaction;
            let settled = false;
            const activity = presence.publishSnapshot({ socket, binding, completeSnapshot: { state: "active", activeCount: 1 } });
            activityOutcome = Promise.allSettled([activity]).finally(() => { settled = true; });
            let observedAccountWait = false;
            while (!settled) {
                const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                    SELECT ${writerPid}::int = ANY(pg_blocking_pids(${activityPid}::int)) AS waiting
                `;
                if (waiting) { observedAccountWait = true; break; }
            }
            expect(observedAccountWait).toBe(true);
            release();
            await writer;
            if (change === "cursor") {
                await expect(activity).resolves.toMatchObject({ status: "applied", projection: {
                    runtimeActivityState: "active", runtimeActivityActiveCount: 1,
                    runtimeActivityRevision: Number(before.runtimeActivityRevision) + 1,
                } });
            } else {
                await expect(activity).resolves.toEqual({ status: "rejected",
                    reason: change === "revoked" ? "unauthorized" : "superseded" });
            }
            const after = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                runtimeActivityState: true, runtimeActivityRevision: true, lastActiveAt: true, updatedAt: true,
            } });
            if (change !== "superseded") expect(after.lastActiveAt).toEqual(before.lastActiveAt);
            if (change !== "cursor") expect(after).toMatchObject({ runtimeActivityState: "unknown",
                runtimeActivityRevision: before.runtimeActivityRevision });
        } finally {
            release();
            await Promise.all([writerOutcome, activityOutcome]);
            db.$transaction = transaction;
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["committed", "standalone"] as const)("replays before the Session guard when %s activation changes to a lower managed controller Account", async targetSource => {
        const stem = `pending-target-race-${randomUUID()}`;
        const custodian = await db.account.create({ data: { id: `${stem}-a`, encryptionMode: "plain" } });
        const requester = await db.account.create({ data: { id: `${stem}-z`, encryptionMode: "plain" } });
        const homeId = `srv_${"f".repeat(32)}`;
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", homeId);
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "3");
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        let allowInitialLock!: () => void;
        const targetMayChange = new Promise<void>(resolve => { allowInitialLock = resolve; });
        let discovered!: () => void;
        const oldTargetDiscovered = new Promise<void>(resolve => { discovered = resolve; });
        let accountLocked!: () => void;
        const requesterLocked = new Promise<void>(resolve => { accountLocked = resolve; });
        let allowRevalidation!: () => void;
        const peerMayWait = new Promise<void>(resolve => { allowRevalidation = resolve; });
        const rawDriverFailures: unknown[] = [];
        let interceptInitialLock = true;
        const transaction = db.$transaction.bind(db);
        let pendingResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
        let peerResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
            const makeMachine = (accountId: string, active: boolean) => db.machine.create({ data: {
                id: randomUUID(), accountId, installationId: randomUUID(), active,
                metadata: encodePlainMachineStoredContent({ host: "target-race", platform: "linux", happyCliVersion: "test",
                    homeDir: "/home/test", happyHomeDir: "/home/test/.happier" }),
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, "base64")),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const previous = await makeMachine(requester.id, true);
            const controller = await makeMachine(custodian.id, true);
            const guest = await makeMachine(custodian.id, false);
            for (const machine of [controller, guest]) expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: "account", accountId: requester.id }, level: "admin",
            }), { isolationLevel: "ReadCommitted" })).toMatchObject({ kind: "saved", readiness: "ready" });
            const managed = await db.managedMachine.create({ data: {
                homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
                controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(), admittedInput: {},
                allocation: "bound", creationState: "active", enrolledMachineId: guest.id, desired: "stop",
                launch: { provider: { pluginId: "fixture.compute", localId: "vm" }, schemaVersion: 1, name: "Retained", choices: {} },
                resource: { contributionRef: { pluginId: "fixture.compute", localId: "vm" }, schemaVersion: 1, value: {} },
                retention: { kind: "until-delete" }, wakeOnAcceptedMessage: true,
                observation: { observedAt: 1, availability: "present", power: "stopped", storage: "retained" },
            } });
            const session = await db.session.create({ data: {
                accountId: requester.id, tag: stem, metadata: "{}", encryptionMode: "plain", active: false,
            } });
            for (const machine of [previous, guest]) await db.accessKey.create({ data: {
                accountId: requester.id, machineId: machine.id, sessionId: session.id, data: "private-key-ciphertext",
            } });
            const target = (machine: typeof guest) => ({ homeId, accountId: requester.id, sessionId: session.id,
                machineId: machine.id, installationId: machine.installationId! });
            const requestId = randomUUID();
            const receipt = (machine: typeof guest) => ({ v: 1, issuer: "authenticatedAccount", actorAccountId: requester.id,
                sessionRelationship: "owner", admittedTarget: target(machine) });
            await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: target(previous) } });
            if (targetSource === "standalone") await db.sessionPendingMessage.create({ data: {
                sessionId: session.id, localId: requestId, position: 1, content: { t: "plain", v: {} },
                messageRole: "user", authorAccountId: requester.id, requestedAction: { v: 1, kind: "send_now" },
                inputAdmissionReceipt: receipt(previous),
            } });
            // Only the real PostgreSQL transport is intercepted. Keep the global
            // default unchanged while exercising this exact owner under RC.
            const execute = async <T>(fn: (tx: Tx) => Promise<T>, options?: { maxWait?: number; timeout?: number }) => transaction(async tx => {
                const observed = new Proxy(tx, { get(boundary, key) {
                    if (key === "$queryRawUnsafe") return async <R>(query: string, ...values: unknown[]): Promise<R> => {
                        const queriedAccountIds = Array.isArray(values[0]) ? values[0] : values;
                        const pause = interceptInitialLock && query.includes('FROM "Account"')
                            && query.includes("FOR KEY SHARE")
                            && queriedAccountIds.includes(requester.id) && !queriedAccountIds.includes(custodian.id);
                        if (pause) {
                            interceptInitialLock = false;
                            discovered();
                            await targetMayChange;
                        }
                        try {
                            const result = await boundary.$queryRawUnsafe<R>(query, ...values);
                            if (pause) { accountLocked(); await peerMayWait; }
                            return result;
                        } catch (error) { rawDriverFailures.push(error); throw error; }
                    }
                    const member: unknown = Reflect.get(boundary, key, boundary);
                    return typeof member === "function" ? member.bind(boundary) : member;
                } });
                return fn(observed);
            }, { ...options, isolationLevel: "ReadCommitted" });
            // Prisma's overload includes batch arrays; inTx uses its interactive
            // callback overload, which this transport adapter preserves.
            db.$transaction = execute as typeof db.$transaction;
            const pending = targetSource === "standalone"
                ? inTx(tx => armPendingActivationAuthorizationInTx({ tx, sessionId: session.id, requestId,
                    currentAccess: { accountId: requester.id, sessionId: session.id, level: "owner" } }))
                : enqueuePendingMessage({ actorUserId: requester.id, sessionId: session.id, localId: requestId,
                    content: { t: "plain", v: { role: "user", content: "race" } }, requestedAction: { v: 1, kind: "send_now" },
                    authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] } });
            pendingResult = Promise.allSettled([pending]);
            await Promise.race([oldTargetDiscovered, pendingResult.then(() => { throw new Error("Pending ended before target discovery"); })]);
            await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: target(guest) } });
            if (targetSource === "standalone") await db.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId: session.id, localId: requestId } },
                data: { inputAdmissionReceipt: receipt(guest) },
            });
            allowInitialLock();
            await Promise.race([requesterLocked, pendingResult.then(() => { throw new Error("Pending ended before Account acquisition"); })]);
            const peer = inTx(async tx => {
                await acquireSessionAccountCursorLocksInTx(tx, [], [custodian.id, requester.id]);
                await markAccountChanged(tx, { accountId: requester.id, kind: "account", entityId: stem });
            }, { isolationLevel: "ReadCommitted" });
            peerResult = Promise.allSettled([peer]);
            // Ordinary content admission must let an unrelated cursor writer
            // finish while this attempt is still revalidating its placement.
            for (const outcome of await peerResult) if (outcome.status === "rejected") throw outcome.reason;
            allowRevalidation();
            const outcomes = [...await pendingResult, ...await peerResult];
            expect(rawDriverFailures).toEqual([]);
            for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
            if (targetSource === "committed") expect(outcomes[0], JSON.stringify(outcomes[0])).toMatchObject({
                status: "fulfilled", value: { ok: true, didWrite: true },
            });
            const row = await db.sessionPendingMessage.findUniqueOrThrow({ where: {
                sessionId_localId: { sessionId: session.id, localId: requestId },
            } });
            expect(row).toMatchObject({ messageRole: "user", authorAccountId: requester.id,
                inputAdmissionReceipt: { admittedTarget: target(guest) } });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                pendingActivationRequestId: true, pendingActivationStatus: true,
            } })).toEqual({ pendingActivationRequestId: requestId, pendingActivationStatus: "waiting" });
            expect(await db.accountChange.findMany({ where: { accountId: custodian.id, kind: "account", entityId: managed.id } }))
                .toMatchObject([{ hint: { managedMachinePolicy: true, machineId: controller.id } }]);
        } finally {
            allowInitialLock?.(); allowRevalidation?.();
            await Promise.all([pendingResult, peerResult]);
            db.$transaction = transaction;
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: requester.id } });
            await db.session.deleteMany({ where: { accountId: requester.id } });
            await db.managedMachine.deleteMany({ where: { custodianAccountId: custodian.id } });
            await db.machine.deleteMany({ where: { accountId: { in: [custodian.id, requester.id] } } });
            await db.account.deleteMany({ where: { id: { in: [custodian.id, requester.id] } } });
        }
    });

    it.each(["explicit", "committed", "standalone", "explicit-unenrolled"] as const)("waits for a foreign target Account before locking the Pending Session through %s admission", async targetSource => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" } });
        const requester = await db.account.create({ data: { encryptionMode: "plain" } });
        const homeId = `srv_${"f".repeat(32)}`;
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", homeId);
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        let releaseController!: () => void;
        const controllerMayContinue = new Promise<void>(resolve => { releaseController = resolve; });
        let controllerReady!: () => void;
        const controllerHasAccount = new Promise<void>(resolve => { controllerReady = resolve; });
        let controllerPid = -1;
        const transaction = db.$transaction.bind(db);
        try {
            const machine = (active: boolean) => db.machine.create({ data: {
                id: randomUUID(), accountId: custodian.id, installationId: randomUUID(), active,
                metadata: encodePlainMachineStoredContent({ host: "lock-order", platform: "linux", happyCliVersion: "test",
                    homeDir: "/home/test", happyHomeDir: "/home/test/.happier" }),
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, "base64")),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const controller = await machine(true);
            const guest = await machine(false);
            for (const target of [controller, guest]) {
                expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                    machineId: target.id, principal: { kind: "account", accountId: requester.id }, level: "admin" })))
                    .toMatchObject({ kind: "saved", readiness: "ready" });
            }
            if (targetSource !== "explicit-unenrolled") await db.managedMachine.create({ data: {
                homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
                controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(), admittedInput: {},
                allocation: "bound", creationState: "active", enrolledMachineId: guest.id, desired: "stop",
                launch: { provider: { pluginId: "fixture.compute", localId: "vm" }, schemaVersion: 1, name: "Retained", choices: {} },
                resource: { contributionRef: { pluginId: "fixture.compute", localId: "vm" }, schemaVersion: 1, value: {} },
                retention: { kind: "until-delete" }, wakeOnAcceptedMessage: true,
                observation: { observedAt: 1, availability: "present", power: "stopped", storage: "retained" },
            } });
            const session = await db.session.create({ data: {
                accountId: requester.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: false,
            } });
            await db.accessKey.create({ data: {
                accountId: requester.id, machineId: guest.id, sessionId: session.id, data: "private-key-ciphertext",
            } });
            const admittedTarget = { homeId, accountId: requester.id, sessionId: session.id,
                machineId: guest.id, installationId: guest.installationId! };
            if (targetSource === "committed") {
                await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: admittedTarget } });
            }
            const requestId = randomUUID();
            await db.sessionPendingMessage.create({ data: {
                sessionId: session.id, localId: requestId, position: 1, content: { t: "plain", v: {} },
                messageRole: "user", authorAccountId: requester.id, requestedAction: { v: 1, kind: "send_now" },
                inputAdmissionReceipt: { v: 1, issuer: "authenticatedAccount", actorAccountId: requester.id,
                    sessionRelationship: "owner", admittedTarget },
            } });
            const execute = async <T>(fn: (tx: Tx) => Promise<T>, options?: { maxWait?: number; timeout?: number }) =>
                transaction(fn, { ...options, isolationLevel: "ReadCommitted" });
            // Only the interactive PostgreSQL transport is adapted; this file
            // exercises RC without changing the product's global default.
            db.$transaction = execute as typeof db.$transaction;
            const holder = inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, custodian.id, "exclusive");
                const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                controllerPid = row.pid;
                controllerReady();
                await controllerMayContinue;
            }, { isolationLevel: "ReadCommitted" });
            const holderResult = Promise.allSettled([holder]);
            await controllerHasAccount;
            let pendingFinished = false;
            const arm = (tx: Tx) =>
                armPendingActivationAuthorizationInTx({ tx, sessionId: session.id, requestId,
                    currentAccess: { accountId: requester.id, sessionId: session.id, level: "owner" } });
            const pending = targetSource === "standalone"
                ? inTx(arm)
                : inPendingQueuePositionTx(session.id, arm, targetSource.startsWith("explicit") ? guest.id : undefined);
            const pendingResult = Promise.allSettled([pending]).finally(() => { pendingFinished = true; });
            try {
                while (!pendingFinished) {
                    const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting",
                        controllerPid,
                    );
                    if (row.waiting) break;
                }
                expect(pendingFinished).toBe(false);
                await expect(inTx(tx => tx.$queryRawUnsafe<{ id: string }[]>(
                    'SELECT "id" FROM "Session" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', session.id,
                ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([{ id: session.id }]);
            } finally { releaseController(); }
            for (const outcome of await holderResult) if (outcome.status === "rejected") throw outcome.reason;
            const [outcome] = await pendingResult;
            if (outcome.status === "rejected") throw outcome.reason;
            if (targetSource === "explicit-unenrolled") expect(outcome.value?.machinePublication)
                .toMatchObject({ target: admittedTarget, custodianAccountId: custodian.id });
            else {
                expect(outcome.value?.managedControllerPublication).toMatchObject({ accountId: custodian.id });
                expect(outcome.value?.managedControllerPublication?.resolveCursor()).toBeGreaterThan(0);
            }
        } finally {
            releaseController?.();
            db.$transaction = transaction;
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: requester.id } });
            await db.session.deleteMany({ where: { accountId: requester.id } });
            await db.managedMachine.deleteMany({ where: { custodianAccountId: custodian.id } });
            await db.machine.deleteMany({ where: { accountId: custodian.id } });
            await db.account.deleteMany({ where: { id: { in: [custodian.id, requester.id] } } });
        }
    });

    it("commits a mode-fenced publisher write and cursor publication without a reciprocal lock cycle", async () => {
        const account = await db.account.create({ data: { publicKey: `lock-order-${randomUUID()}` } });
        let releaseOwner!: () => void;
        const ownerMayContinue = new Promise<void>(resolve => { releaseOwner = resolve; });
        try {
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: account.id, metadata: "{}", installationId: randomUUID(),
            } });
            const session = await db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: "{}",
            } });
            await db.accessKey.create({ data: {
                accountId: account.id, machineId: machine.id, sessionId: session.id, data: "encrypted",
            } });
            const presence = createSessionPublisherPresence();
            const registered = await presence.registerPublisher({
                socket: {}, binding: { accountId: account.id, machineId: machine.id, sessionId: session.id },
                completeActivitySnapshot: { state: "unknown", activeCount: 0 },
            });
            if (registered.status !== "registered") throw new Error("Publisher fixture did not register");
            const authority = { accountId: account.id, machineId: machine.id, sessionId: session.id,
                committedFence: registered.committedFence };
            const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            const timestamps = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                lastActiveAt: true, updatedAt: true,
            } });
            vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
            let ownerReady!: () => void;
            const ownerHasAccount = new Promise<void>(resolve => { ownerReady = resolve; });
            const owner = inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
                ownerReady();
                await ownerMayContinue;
                expect(await fenceExactCurrentPublisherAuthorityInTx(tx, authority, account.id, session.id)).toBe(true);
                return markAccountChanged(tx, { accountId: account.id, kind: "session", entityId: session.id });
            }, { isolationLevel: "ReadCommitted" });
            // Attach rejection handlers immediately; the deadlock victim is an expected RED outcome.
            const ownerResult = Promise.allSettled([owner]);
            await ownerHasAccount;
            let publisherPid = -1;
            let publisherFenced = false;
            let publisherFinished = false;
            const publisher = inTx(async tx => {
                const rows = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                publisherPid = rows[0].pid;
                expect(await fenceExactCurrentPublisherAuthorityInTx(tx, authority, account.id, session.id)).toBe(true);
                publisherFenced = true;
                return markAccountChanged(tx, { accountId: account.id, kind: "session", entityId: session.id });
            }, { isolationLevel: "ReadCommitted" });
            const publisherResult = Promise.allSettled([publisher]).finally(() => { publisherFinished = true; });
            try {
                // Before the fix, publisher owns Session and then waits on Account.
                // After the fix, it waits on Account before touching Session. Observe
                // that real boundary rather than holding it behind an artificial barrier.
                while (!publisherFenced && !publisherFinished) {
                    const waiting = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting",
                        publisherPid,
                    );
                    if (waiting[0].waiting) break;
                }
            } finally { releaseOwner(); }
            const outcomes = [...await ownerResult, ...await publisherResult];
            for (const outcome of outcomes) {
                if (outcome.status === "rejected") throw outcome.reason;
            }
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: before.seq + 2 });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                lastActiveAt: true, updatedAt: true,
            } })).toEqual(timestamps);
        } finally {
            releaseOwner?.();
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
