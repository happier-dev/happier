import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountNameUpdateResponseV1Schema } from "@happier-dev/protocol/account/profile";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { registerAccountProfileRoute } from "./registerAccountProfileRoute";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { acquireAccountChangePublicationLocksInTx, markAccountChanged } from "@/app/changes/markAccountChanged";
import { eventRouter } from "@/app/events/eventRouter";

function latch() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Account name terminal assignment", () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
        await db.$executeRawUnsafe('CREATE TABLE "AccountProfileWriteObservation" ("accountId" text NOT NULL)');
        await db.$executeRawUnsafe(`CREATE FUNCTION "observeAccountProfileWrite"() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
                INSERT INTO "AccountProfileWriteObservation" ("accountId") VALUES (NEW."id");
                RETURN NEW;
            END $$`);
        await db.$executeRawUnsafe(`CREATE TRIGGER "observeAccountProfileWrite"
            AFTER UPDATE ON "Account" FOR EACH ROW EXECUTE FUNCTION "observeAccountProfileWrite"()`);
    });
    afterAll(async () => {
        eventRouter.clearIo();
        if (!connected) return;
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "observeAccountProfileWrite" ON "Account"');
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS "observeAccountProfileWrite"()');
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "AccountProfileWriteObservation"');
        await db.$disconnect();
    });

    async function writeCount(accountId: string): Promise<number> {
        const [row] = await db.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count FROM "AccountProfileWriteObservation" WHERE "accountId" = ${accountId}
        `;
        return row.count;
    }

    it("equal normalized names have no physical writes, cursors or socket updates while real changes retain their response", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain", name: "Captain Nemo" } });
        const emissions: unknown[] = [];
        // Socket.IO delivery is the network boundary; the route, transaction,
        // native row updates, cursor allocation and event routing stay real.
        eventRouter.setIo({ to: () => ({ emit: (_event: string, payload: unknown) => { emissions.push(payload); },
            disconnectSockets: () => {} }) });
        try {
            await withAuthenticatedTestApp(registerAccountProfileRoute, async app => {
                for (let index = 0; index < 20; index++) {
                    const response = await app.inject({ method: "POST", url: "/v1/account/profile",
                        headers: { "x-test-user-id": account.id }, payload: { name: "  Captain Nemo  " } });
                    expect(response.statusCode).toBe(200);
                    expect(AccountNameUpdateResponseV1Schema.parse(response.json()))
                        .toMatchObject({ name: "Captain Nemo", firstName: "Captain Nemo", lastName: null });
                }
                expect(await writeCount(account.id)).toBe(0);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(account);
                expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
                expect(emissions).toHaveLength(0);

                const changed = await app.inject({ method: "POST", url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id }, payload: { name: null } });
                expect(changed.statusCode).toBe(200);
                expect(AccountNameUpdateResponseV1Schema.parse(changed.json()))
                    .toMatchObject({ name: null, firstName: null, lastName: null });
                expect(await writeCount(account.id)).toBe(2);
                const committed = await db.account.findUniqueOrThrow({ where: { id: account.id } });
                expect(committed).toMatchObject({ name: null, seq: account.seq + 1 });
                const change = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                    accountId: account.id, kind: "account", entityId: "self",
                } } });
                expect(change).toMatchObject({ cursor: committed.seq, hint: { name: true } });
                expect(emissions).toEqual(expect.arrayContaining([
                    expect.objectContaining({ seq: change.cursor, body: expect.objectContaining({ name: null }) }),
                ]));
                const publishedCount = emissions.length;
                const equalNull = await app.inject({ method: "POST", url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id }, payload: { name: "   " } });
                expect(equalNull.statusCode).toBe(200);
                expect(AccountNameUpdateResponseV1Schema.parse(equalNull.json()))
                    .toMatchObject({ name: null, firstName: null, lastName: null });
                expect(await writeCount(account.id)).toBe(2);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(committed);
                expect(emissions).toHaveLength(publishedCount);
            });
        } finally {
            eventRouter.clearIo();
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("concurrent equal replacements publish exactly one committed name change", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        try {
            await withAuthenticatedTestApp(registerAccountProfileRoute, async app => {
                const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({
                    method: "POST", url: "/v1/account/profile", headers: { "x-test-user-id": account.id },
                    payload: { name: "Captain Nemo" },
                })));
                expect(responses.map(response => response.statusCode)).toEqual(Array.from({ length: 8 }, () => 200));
                expect(await writeCount(account.id)).toBe(2);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id } }))
                    .toMatchObject({ name: "Captain Nemo", seq: account.seq + 1 });
                expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(1);
            });
        } finally {
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("allows ordinary Session domain work while the public name assignment holds its Account row", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const assigned = latch(), release = latch();
        const transaction = db.$transaction;
        let namePid = 0;
        let sessionPid = 0;
        let sessionInDomain = false;
        let sessionSettled = false;
        let intercepted = false;
        const emitted = vi.spyOn(eventRouter, "emitUpdate");
        // Prisma is the real database boundary. Pause only after the native
        // name UPDATE; admission, publication, route and event logic stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== "account") return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.account, { get(model, method, modelReceiver) {
                    if (method !== "update") return Reflect.get(model, method, modelReceiver);
                    return async (...queryArgs: unknown[]) => {
                        const query = queryArgs[0];
                        const result = await Reflect.apply(model.update, model, queryArgs);
                        if (!intercepted && typeof query === "object" && query !== null && "data" in query
                            && typeof query.data === "object" && query.data !== null && "name" in query.data) {
                            intercepted = true;
                            [{ pid: namePid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            assigned.release();
                            await release.promise;
                        }
                        return result;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(registerAccountProfileRoute, async app => {
                const nameWrite = app.inject({ method: "POST", url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id }, payload: { name: "Captain" } });
                const nameOutcome = Promise.allSettled([nameWrite]);
                let writerOutcome: Promise<PromiseSettledResult<void>[]> | undefined;
                try {
                    await Promise.race([assigned.promise, nameWrite.then(() => { throw new Error("Name write did not reach assignment"); })]);
                    const writer = inTx(async tx => {
                        [{ pid: sessionPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                        await acquireAccountChangePublicationLocksInTx(tx, [account.id], { includeSingleAccount: true });
                        await tx.session.update({ where: { id: session.id }, data: { metadata: '{"changed":true}' } });
                        sessionInDomain = true;
                        await markAccountChanged(tx, { accountId: account.id, kind: "session", entityId: session.id });
                    }).finally(() => { sessionSettled = true; });
                    writerOutcome = Promise.allSettled([writer]);
                    while (!sessionInDomain && !sessionSettled) {
                        const [sample] = await db.$queryRaw<Array<{ blockers: number[] }>>`
                            SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = ${sessionPid}
                        `;
                        if (sample?.blockers.includes(namePid)) break;
                    }
                    expect(sessionInDomain).toBe(true);
                } finally {
                    release.release();
                    for (const outcome of await writerOutcome ?? []) if (outcome.status === "rejected") throw outcome.reason;
                    await nameOutcome;
                }
                const response = await nameWrite;
                expect(response.statusCode).toBe(200);
                expect(AccountNameUpdateResponseV1Schema.parse(response.json())).toMatchObject({ name: "Captain", firstName: "Captain", lastName: null });
                const change = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                    accountId: account.id, kind: "account", entityId: "self",
                } } });
                expect(change.hint).toEqual({ name: true });
                expect(emitted.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
                    userId: account.id, recipientFilter: { type: "user-scoped-only" },
                    payload: expect.objectContaining({ seq: change.cursor, body: expect.objectContaining({ name: "Captain" }) }),
                }));
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { name: true } })).toEqual({ name: "Captain" });
            });
        } finally {
            release.release();
            db.$transaction = transaction;
            emitted.mockRestore();
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
