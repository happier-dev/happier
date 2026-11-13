import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { db, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { acquireAccountEncryptionTransitionCoordinatorFenceInTx } from "./accountEncryptionTransitionCoordinator";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "./accountSessionOwnerMetadataFence";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Account transition complete admission", () => {
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing disposable PostgreSQL contract DATABASE_URL");
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => {
        await db.$disconnect();
        if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
    });

    it.each(["Artifact", "Discussion", "Machine", "Workflow", "Task"] as const)("excludes a %s recipient's admitted writer before transition domain work", async kind => {
        const [owner, recipient] = await Promise.all([0, 1].map(() => db.account.create({ data: { encryptionMode: "plain" } })));
        const targetBinding = kind === "Discussion" ? createSignedAccountContentBinding() : null;
        if (kind === "Artifact") {
            const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
                header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
            await db.artifactGrant.create({ data: { principalKind: 'account' as const, artifactId: artifact.id, accountId: recipient.id,
                accessLevel: "view", createdByAccountId: owner.id } });
        } else if (kind === "Discussion") {
            const discussion = await db.discussion.create({ data: { ownerAccountId: owner.id, encryptionMode: "plain",
                dataEncryptionKey: new Uint8Array(), titleContent: { t: "plain", v: "Title" },
                creationLocalId: randomUUID(), creationEqualityEvidenceV1: {}, lastMessageAt: new Date() } });
            await db.discussionGrant.create({ data: { principalKind: 'account' as const, discussionId: discussion.id, accountId: recipient.id,
                accessLevel: "view", createdByAccountId: owner.id } });
        } else if (kind === "Machine") {
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: "{}" } });
            await db.machineGrant.create({ data: { principalKind: 'account' as const, machineId: machine.id, accountId: recipient.id,
                accessLevel: "view", createdByAccountId: owner.id } });
        } else if (kind === "Task") {
            const task = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${randomUUID()}`,
                value: new TextEncoder().encode(JSON.stringify({ t: "plain", v: { title: "Shared task" } })) } });
            await db.taskGrant.create({ data: { principalKind: 'account' as const, taskId: task.id, accountId: recipient.id,
                accessLevel: "view", createdByAccountId: owner.id } });
        } else {
            const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: "direct", causeKind: null,
                scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}" } });
            const watcher = await db.automation.create({ data: { accountId: recipient.id, name: "Lifecycle watcher",
                enabled: true, templateCiphertext: "{}", templateVersion: 1 } });
            await db.automationTrigger.create({ data: { automationId: watcher.id, kind: "runLifecycle", enabled: true,
                sourceRunId: run.id, remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify({ kind: "runLifecycle",
                    source: { kind: "workflow_run", runId: run.id }, condition: "terminal" }) } });
        }
        const holderEntered = deferred();
        const releaseHolder = deferred();
        const transitionStarted = deferred();
        let transitionEntered = false;
        let transitionSettled = false;
        let transitionPid = 0;
        const holder = Promise.allSettled([inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, recipient.id, "content");
            holderEntered.resolve();
            await releaseHolder.promise;
        })]);
        await holderEntered.promise;
        const transition = Promise.allSettled([inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>("SELECT pg_backend_pid() AS pid");
            transitionPid = backend.pid;
            transitionStarted.resolve();
            expect(await acquireAccountEncryptionTransitionCoordinatorFenceInTx(tx, owner.id)).toMatchObject({ status: "ready" });
            transitionEntered = true;
            if (targetBinding) {
                // The real migration converts Discussion rows before its final
                // nested Account fence flips the Account mode. That temporary
                // projection is empty, then returns to its original audience.
                await tx.discussion.updateMany({ where: { ownerAccountId: owner.id }, data: { encryptionMode: "e2ee" } });
                expect(await acquireAccountEncryptionTransitionCoordinatorFenceInTx(tx, owner.id)).toMatchObject({ status: "ready" });
                await tx.account.update({ where: { id: owner.id }, data: { ...targetBinding, encryptionMode: "e2ee" } });
            }
            await markAccountChanged(tx, { accountId: owner.id, kind: "account", entityId: "self" });
        })]).finally(() => { transitionSettled = true; });
        try {
            await transitionStarted.promise;
            let blockers: number[] = [];
            while (!transitionEntered && !transitionSettled && blockers.length === 0) {
                [ { blockers } ] = await db.$queryRawUnsafe<Array<{ blockers: number[] }>>(
                    "SELECT pg_blocking_pids($1::int) AS blockers", transitionPid,
                );
            }
            expect(transitionEntered, `${kind} recipients must be admitted at the strongest entry mode`).toBe(false);
            expect(blockers.length).toBeGreaterThan(0);
        } finally {
            releaseHolder.resolve();
            const outcomes = [...await holder, ...await transition];
            const ids = [owner.id, recipient.id];
            await db.accountChange.deleteMany({ where: { accountId: { in: ids } } });
            await db.artifact.deleteMany({ where: { accountId: { in: ids } } });
            await db.discussion.deleteMany({ where: { ownerAccountId: { in: ids } } });
            await db.machine.deleteMany({ where: { accountId: { in: ids } } });
            await db.automationTrigger.deleteMany({ where: { automation: { accountId: { in: ids } } } });
            await db.automationRun.deleteMany({ where: { accountId: { in: ids } } });
            await db.automation.deleteMany({ where: { accountId: { in: ids } } });
            await db.account.deleteMany({ where: { id: { in: ids } } });
            for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
        }
    });

    it("admits reciprocal Session audiences exclusively before either transition starts domain work", async () => {
        const accounts = await Promise.all([0, 1].map(() => db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        })));
        const sessions = await Promise.all(accounts.map(account => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        }, select: { id: true } })));
        for (let index = 0; index < accounts.length; index++) await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: sessions[index].id, createdByAccountId: accounts[index].id,
            accountId: accounts[1 - index].id,
        } });
        const firstEntered = deferred();
        const secondStarted = deferred();
        const releaseFirst = deferred();
        let secondEntered = false;
        let secondSettled = false;
        let secondPid = 0;
        let exerciseResources = false;
        const transition = (index: number) => inTx(async tx => {
            if (index === 1) {
                const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>("SELECT pg_backend_pid() AS pid");
                secondPid = backend.pid;
                secondStarted.resolve();
            }
            expect(await acquireAccountEncryptionTransitionCoordinatorFenceInTx(tx, accounts[index].id))
                .toMatchObject({ status: "ready" });
            if (index === 0) { firstEntered.resolve(); await releaseFirst.promise; }
            else secondEntered = true;
            if (exerciseResources) {
                await acquireSessionAccountCursorLocksInTx(tx, [sessions[index].id], [accounts[index].id]);
                await tx.session.update({ where: { id: sessions[index].id }, data: { metadata: JSON.stringify({ index }) } });
                for (const account of accounts) await markAccountChanged(tx, {
                    accountId: account.id, kind: "session", entityId: sessions[index].id,
                });
            }
        });
        const first = Promise.allSettled([transition(0)]);
        await firstEntered.promise;
        const second = Promise.allSettled([transition(1)]).finally(() => { secondSettled = true; });
        try {
            await secondStarted.promise;
            let blockers: number[] = [];
            while (!secondEntered && !secondSettled && blockers.length === 0) {
                [ { blockers } ] = await db.$queryRawUnsafe<Array<{ blockers: number[] }>>(
                    "SELECT pg_blocking_pids($1::int) AS blockers", secondPid,
                );
            }
            expect(secondEntered, "the foreign recipient must be admitted before the target Account can enter domain work").toBe(false);
            expect(blockers.length).toBeGreaterThan(0);
            exerciseResources = true;
        } finally {
            releaseFirst.resolve();
            const outcomes = [...await first, ...await second];
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: { in: sessions.map(session => session.id) } } });
            await db.accountChange.deleteMany({ where: { accountId: { in: accounts.map(account => account.id) } } });
            await db.session.deleteMany({ where: { id: { in: sessions.map(session => session.id) } } });
            await db.account.deleteMany({ where: { id: { in: accounts.map(account => account.id) } } });
            for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
        }
    });
});
