import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { inTx, type Tx } from "@/storage/inTx";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { eventRouter } from "@/app/events/eventRouter";
import { acquireMachinePublicationLocksInTx } from "@/app/api/socket/machinePublication";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireMachineAccessPublicationLocksInTx } from "@/app/machines/machineAccess";
import { prepareLayout1SessionCreate } from "./prepareLayout1SessionCreate";
import { createOrRejoinLayout1SessionByTag } from "./createOrRejoinLayout1SessionByTag";

// Observe the real SQL boundary, including terminal publication, without replacing
// any admission, projection or transaction owner.
describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Session creation transaction shape", () => {
    const measured = new PrismaClient({ log: [{ emit: "event", level: "query" }], errorFormat: "minimal" });
    const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        await measured.$connect();
        // Warm the process-owned operator budget read outside the measured births.
        await inTx(async () => undefined);
    });
    afterAll(async () => { await measured.$disconnect(); await db.$disconnect(); });

    it("keeps unrelated Session inventory out of creation and emits only after commit", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const member = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Session transaction shape" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: member.id, role: "member" },
        ] });
        const transaction = db.$transaction;
        let active = false;
        let capture = false;
        let statements: Array<{ query: string; durationMs: number }> = [];
        const publicationsInTransaction: string[] = [];
        const emit = eventRouter.emitUpdate;
        const publication = vi.spyOn(eventRouter, "emitUpdate").mockImplementation((...args) => {
            if (active) publicationsInTransaction.push("emitUpdate");
            return emit.apply(eventRouter, args);
        });
        measured.$on("query", event => {
            if (capture) statements.push({ query: event.query, durationMs: event.duration });
        });
        const runs: Array<{ inventory: number; elapsedMs: number; statements: typeof statements }> = [];
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(measured.$transaction, measured, [async (tx: Tx) => {
                active = true;
                try { return await callback(tx); } finally { active = false; }
            }, ...args.slice(1)]);
        } });
        try {
            for (const inventory of [0, 1000]) {
                if (inventory) await db.session.createMany({ data: Array.from({ length: inventory }, () => ({
                    accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
                })) });
                const input = prepareLayout1SessionCreate({
                    accountId: owner.id, tag: randomUUID(), metadata: "{\"v\":1}", ownerMetadata: { t: "plain", v: { v: 1 } },
                    agentState: null, dataEncryptionKey: null, requestedEncryptionMode: "plain", requestedStorageState: undefined,
                    organizationPlacement: undefined, accountEncryptionMode: "plain", storagePolicy: "optional", defaultAccountMode: "plain",
                    primaryTeamId: team.id,
                    initialAccess: { grants: [{ subject: { kind: "account", accountId: member.id },
                        accessLevel: "view", canApprovePermissions: false }] },
                });
                if (!input.ok) throw new Error("Invalid Session transaction fixture");
                statements = [];
                const started = performance.now();
                capture = true;
                const result = await createOrRejoinLayout1SessionByTag(input.prepared, authentication);
                capture = false;
                runs.push({ inventory, elapsedMs: performance.now() - started, statements });
                expect(result.kind).toBe("created");
                if (result.kind !== "created") throw new Error("Expected Session birth");
                expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: result.session.id, accountId: member.id } })).toBe(1);
            }
            console.info("SESSION_CREATE_SHAPE", JSON.stringify(runs.map(run => ({
                inventory: run.inventory, elapsedMs: run.elapsedMs,
                statementCount: run.statements.length,
                sqlDurationMs: run.statements.reduce((sum, statement) => sum + statement.durationMs, 0),
                statements: run.statements,
            }))));
            for (const run of runs) {
                const publicationLock = run.statements.findIndex(statement => /FROM "Account".*FOR NO KEY UPDATE/.test(statement.query));
                expect(publicationLock).toBeGreaterThan(-1);
                const lateAdmissionReads = run.statements.slice(publicationLock + 1).filter(statement =>
                    /^SELECT /.test(statement.query) && /FROM "(?:public"\.)?"?(?:Session|Team|TeamMembership|Account)"/.test(statement.query));
                expect(lateAdmissionReads.map(statement => statement.query)).toEqual([]);
            }
            const queryShape = (query: string) => query.replace(/SET LOCAL statement_timeout = \d+/, "SET LOCAL statement_timeout = <budget>");
            expect(runs[1].statements.map(statement => queryShape(statement.query)))
                .toEqual(runs[0].statements.map(statement => queryShape(statement.query)));
            expect(publication).toHaveBeenCalled();
            expect(publicationsInTransaction).toEqual([]);
            expect(await db.session.count({ where: { accountId: owner.id } })).toBe(1002);
        } finally {
            capture = false;
            db.$transaction = transaction;
            publication.mockRestore();
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
        }
    });

    it.each(["content", "grant"] as const)("finishes Machine %s recipient admission before the terminal Account lock", async admission => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: "{}" } });
        const statements: string[] = [];
        let capture = true;
        measured.$on("query", event => { if (capture) statements.push(event.query); });
        const transaction = db.$transaction;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            if (typeof args[0] !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(measured.$transaction, measured, args);
        } });
        try {
            await inTx(async tx => {
                if (admission === "content") {
                    const recipients = await acquireMachinePublicationLocksInTx(tx, machine.id);
                    expect(recipients).toEqual([owner.id]);
                } else {
                    await acquireMachineAccessPublicationLocksInTx(tx, machine.id);
                }
                await tx.machine.update({ where: { id: machine.id }, data: { daemonState: "{}", daemonStateVersion: 1 } });
                await markAccountChanged(tx, { accountId: owner.id, kind: "machine", entityId: machine.id });
            });
            capture = false;
            const publicationLock = statements.findIndex(query => /FROM "Account".*FOR NO KEY UPDATE/.test(query));
            expect(publicationLock).toBeGreaterThan(-1);
            const lateRecipientReads = statements.slice(publicationLock + 1).filter(query =>
                /^\s*(?:SELECT\b|WITH RECURSIVE\b)/.test(query) && /\b(?:FROM|JOIN) "(?:public"\.)?"?(?:Machine|Session|SessionTeamGrant|TeamMembership)"/.test(query));
            console.info("MACHINE_PUBLICATION_SHAPE", JSON.stringify({
                admission, statementCount: statements.length, lateRecipientReadCount: lateRecipientReads.length,
            }));
            expect(lateRecipientReads).toEqual([]);
            expect(await db.machine.findUnique({ where: { id: machine.id }, select: { daemonStateVersion: true } }))
                .toEqual({ daemonStateVersion: 1 });
            expect(await db.accountChange.count({ where: { accountId: owner.id, kind: "machine", entityId: machine.id } })).toBe(1);
        } finally {
            capture = false;
            db.$transaction = transaction;
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
});
