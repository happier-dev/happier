import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from "@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1";
import { StoredJsonContentEnvelopeSchema, TaskResourceStoredJsonContentEnvelopeSchema } from "@happier-dev/protocol/storage/storedJsonContentEnvelope";

import { eventRouter } from "@/app/events/eventRouter";
import { assertAccountJsonKvMutationStoredContent } from "@/app/kv/accountJsonKvStoredContent";
import { applyUserKvMutationsInTx, kvMutateInTx } from "@/app/kv/kvMutate";
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { kvRoutes } from "./kvRoutes";
import { taskRoutes } from "../todos/taskRoutes";
import { makeShareEligibleForTest } from "@/testkit/shareEligibility.testkit";
import { buildTaskResourceChangeEntityIdV1 } from "@happier-dev/protocol/actions/internalTaskActions";
import { observePrismaReads } from "@/testkit/observePrismaReads";

const currentHeaders = { "x-happier-account-stored-content-protocol": String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
const taskBytes = Buffer.from(JSON.stringify(TaskResourceStoredJsonContentEnvelopeSchema.parse({ t: "encrypted", k: "task", c: "task-ciphertext" })));
const accountBytes = Buffer.from(JSON.stringify(StoredJsonContentEnvelopeSchema.parse({ t: "encrypted", c: "account-ciphertext" })));
const provider = getDbProviderFromEnv(process.env, "postgres");

describe.skipIf(provider !== "postgres" && provider !== "mysql")("task ciphertext at raw KV ingress", () => {
    const accounts: string[] = [];
    let connected = false;
    beforeAll(async () => {
        const databaseUrl = provider === "mysql" ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!databaseUrl || process.env.DATABASE_URL !== databaseUrl) {
            throw new Error("Run with the disposable native DB-contract harness");
        }
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        eventRouter.clearIo();
        if (connected) {
            await db.account.deleteMany({ where: { id: { in: accounts } } });
            await db.$disconnect();
        }
    });
    async function account(mode: "plain" | "e2ee" = "e2ee") {
        const row = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === "e2ee" ? createSignedAccountContentBinding() : {}) } });
        accounts.push(row.id);
        return row;
    }

    it("refuses resource reads, raw writes, deletes and conflicts without changing bytes or socket publication", async () => {
        const owner = await account();
        const key = "todo.shared";
        await db.userKVStore.create({ data: { accountId: owner.id, key, value: taskBytes, version: 7 } });
        const emit = vi.fn();
        // Socket.IO is the transport boundary; the KV classifier/publication path stays real.
        eventRouter.setIo({ to: () => ({ emit }) } as unknown as Parameters<typeof eventRouter.setIo>[0]);
        await withAuthenticatedTestApp(kvRoutes, async app => {
            for (const authKind of ["account", "terminal"]) {
                for (const headers of [{}, currentHeaders]) {
                    for (const request of [
                        { method: "GET" as const, url: `/v1/kv/${key}` },
                        { method: "GET" as const, url: "/v1/kv?prefix=todo." },
                        { method: "POST" as const, url: "/v1/kv/bulk", payload: { keys: [key] } },
                        ...[taskBytes.toString("base64"), accountBytes.toString("base64"), null].flatMap(value => [7, 6].map(version => ({
                            method: "POST" as const, url: "/v1/kv", payload: { mutations: [{ key, value, version }] },
                        }))),
                        { method: "POST" as const, url: "/v1/kv", payload: { mutations: [{ key: "todo.fabricated", value: taskBytes.toString("base64"), version: -1 }] } },
                    ]) {
                        const response = await app.inject({ ...request, headers: { ...headers,
                            "x-test-user-id": owner.id, "x-test-auth-token-kind": authKind } });
                        expect(response.statusCode, response.body).toBe(headers === currentHeaders ? 400 : 426);
                        expect(response.body).not.toContain(taskBytes.toString("base64"));
                    }
                }
            }
        });
        expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: owner.id, key } }, select: { version: true, value: true } }))
            .toEqual({ version: 7, value: new Uint8Array(taskBytes) });
        expect(await db.userKVStore.count({ where: { accountId: owner.id } })).toBe(1);
        expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(0);
        expect(emit).not.toHaveBeenCalled();
        eventRouter.clearIo();
    });

    it("admits plain, current Account-encrypted and released opaque owner content", async () => {
        for (const vector of [
            { mode: "plain" as const, bytes: Buffer.from(JSON.stringify(StoredJsonContentEnvelopeSchema.parse({ t: "plain", v: { title: "plain task" } }))), headers: currentHeaders },
            { mode: "e2ee" as const, bytes: accountBytes, headers: currentHeaders },
            { mode: "e2ee" as const, bytes: Buffer.from("released-opaque-ciphertext"), headers: {} },
        ]) {
            const owner = await account(vector.mode);
            await withAuthenticatedTestApp(kvRoutes, async app => {
                const headers = { ...vector.headers, "x-test-user-id": owner.id };
                const create = await app.inject({ method: "POST", url: "/v1/kv", headers,
                    payload: { mutations: [{ key: "todo.personal", value: vector.bytes.toString("base64"), version: -1 }] } });
                expect(create.statusCode, create.body).toBe(200);
                const read = await app.inject({ method: "GET", url: "/v1/kv/todo.personal", headers });
                expect(read.statusCode, read.body).toBe(200);
                expect(read.json()).toMatchObject({ value: vector.bytes.toString("base64"), version: 0 });
            });
        }
    });

    it("validates a promoted task snapshot read after a late raw CAS refusal", async () => {
        const owner = await account();
        const key = "todo.promoted";
        await db.userKVStore.create({ data: { accountId: owner.id, key, value: accountBytes, version: 0 } });
        const transaction = db.$transaction;
        let promoted = false;
        // Interleave at the database boundary after raw admission but before its
        // CAS. The competing owner uses the same canonical representation/CAS owners.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== "userKVStore") return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.userKVStore, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== "updateMany") return operation;
                    return async (...values: unknown[]) => {
                        if (!promoted) {
                            promoted = true;
                            await inTx(peer => applyUserKvMutationsInTx(peer, { uid: owner.id }, [{ key, version: 0, value: taskBytes.toString("base64") }], (mutation, existing) => {
                                assertAccountJsonKvMutationStoredContent({ key, persistedValue: existing?.value ?? null,
                                    nextValue: mutation.value === null ? null : Buffer.from(mutation.value, "base64"),
                                    accountMode: "e2ee", supportsCurrentProtocol: true, usage: "task_resource_promotion" });
                            }));
                        }
                        return Reflect.apply(operation, delegate, values);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(kvRoutes, async app => {
                const response = await app.inject({ method: "POST", url: "/v1/kv", headers: { ...currentHeaders, "x-test-user-id": owner.id },
                    payload: { mutations: [{ key, version: 0, value: accountBytes.toString("base64") }] } });
                expect(promoted).toBe(true);
                expect(response.statusCode, response.body).toBe(400);
                expect(response.body).not.toContain(taskBytes.toString("base64"));
            });
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: owner.id, key } }, select: { version: true, value: true } }))
                .toEqual({ version: 1, value: new Uint8Array(taskBytes) });
        } finally { db.$transaction = transaction; }
    });

    it("publishes Plain shared raw edits as qualified content-free changes to the live task audience", async () => {
        const owner = await account("plain");
        const reader = await account("plain");
        await makeShareEligibleForTest(owner.id, [reader.id]);
        const taskId = "shared-plain";
        const key = `todo.${taskId}`;
        const plain = (title: string) => Buffer.from(JSON.stringify(StoredJsonContentEnvelopeSchema.parse({ t: "plain", v: { id: taskId, title, done: false } })));
        await db.userKVStore.createMany({ data: [
            { accountId: owner.id, key, value: plain("Original"), version: 0 },
            { accountId: owner.id, key: "todo.index", value: Buffer.from(JSON.stringify({ t: "plain", v: { undoneOrder: [taskId], completedOrder: [] } })), version: 0 },
        ] });
        const delivered: Array<{ room: string | string[]; payload: unknown }> = [];
        eventRouter.setIo({ to: (room: string | string[]) => ({ emit: (_event: string, payload: unknown) => { delivered.push({ room, payload }); } }) } as unknown as Parameters<typeof eventRouter.setIo>[0]);
        try {
            await withAuthenticatedTestApp(app => { kvRoutes(app); taskRoutes(app); }, async app => {
                const ownerHeaders = { ...currentHeaders, "x-test-user-id": owner.id };
                const taskUrl = `/v1/tasks/${owner.id}/${taskId}`;
                const principal = { kind: "account", accountId: reader.id };
                const shared = await app.inject({ method: "PUT", url: `${taskUrl}/grants`, headers: ownerHeaders,
                    payload: { principal, accessLevel: "view" } });
                expect(shared.statusCode, shared.body).toBe(200);
                const entityId = buildTaskResourceChangeEntityIdV1({ ownerAccountId: owner.id, taskId });
                const before = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: { accountId: reader.id, kind: "kv", entityId } } });
                delivered.length = 0;
                const changed = await app.inject({ method: "POST", url: "/v1/kv", headers: ownerHeaders,
                    payload: { mutations: [
                        { key, version: 0, value: plain("Shared raw edit").toString("base64") },
                        { key: "todo.index", version: 0, value: Buffer.from(JSON.stringify({ t: "plain", v: { undoneOrder: [taskId], completedOrder: [] } })).toString("base64") },
                    ] } });
                expect(changed.statusCode, changed.body).toBe(200);
                const after = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: { accountId: reader.id, kind: "kv", entityId } } });
                expect(after.cursor).toBeGreaterThan(before.cursor);
                expect(after.hint).toBeNull();
                const forReader = delivered.filter(item => (Array.isArray(item.room) ? item.room : [item.room]).some(room => room.includes(reader.id)));
                expect(forReader.length).toBeGreaterThan(0);
                expect(JSON.stringify(forReader)).toContain(entityId);
                expect(JSON.stringify(forReader)).not.toContain("Shared raw edit");
                expect(JSON.stringify(forReader)).not.toContain(plain("Shared raw edit").toString("base64"));
                const read = await app.inject({ method: "GET", url: taskUrl, headers: { "x-test-user-id": reader.id } });
                expect(read.statusCode, read.body).toBe(200);
                expect(read.json()).toMatchObject({ version: 1, content: { t: "plain", v: { title: "Shared raw edit" } } });
                expect((await app.inject({ method: "DELETE", url: `${taskUrl}/grants`, headers: ownerHeaders, payload: { principal } })).statusCode).toBe(200);
                const revoked = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: { accountId: reader.id, kind: "kv", entityId } } });
                delivered.length = 0;
                const unshared = await app.inject({ method: "POST", url: "/v1/kv", headers: ownerHeaders,
                    payload: { mutations: [{ key, version: 1, value: plain("Private edit").toString("base64") }] } });
                expect(unshared.statusCode, unshared.body).toBe(200);
                expect((await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: { accountId: reader.id, kind: "kv", entityId } } })).cursor).toBe(revoked.cursor);
                expect(delivered.filter(item => (Array.isArray(item.room) ? item.room : [item.room]).some(room => room.includes(reader.id)))).toEqual([]);
                expect((await app.inject({ method: "GET", url: taskUrl, headers: { "x-test-user-id": reader.id } })).statusCode).toBe(404);
            });
        } finally { eventRouter.clearIo(); }
    });

    it("set-loads only changed task grant facts for an entire raw mutation batch, including deletion", async () => {
        const owner = await account("plain");
        const reader = await account("plain");
        // 100 is the existing public KV mutation batch boundary, not a new budget.
        const keys = Array.from({ length: 100 }, (_, index) => `todo.batch-${index}`);
        const bytes = Buffer.from(JSON.stringify(StoredJsonContentEnvelopeSchema.parse({ t: "plain", v: { title: "Batch" } })));
        await db.userKVStore.createMany({ data: keys.map(key => ({ accountId: owner.id, key, value: bytes, version: 0 })) });
        const rows = await db.userKVStore.findMany({ where: { accountId: owner.id }, select: { id: true } });
        await db.taskGrant.createMany({ data: rows.map(row => ({ principalKind: 'account' as const, taskId: row.id, accountId: reader.id,
            createdByAccountId: owner.id, accessLevel: "view" as const })) });
        const costs: number[] = [];
        for (const count of [1, 100]) {
            const result = await inTx(async tx => {
                const observed = observePrismaReads(tx, ["userKVStore"]);
                const result = await kvMutateInTx(observed.tx, { uid: owner.id }, keys.slice(0, count).map((key, index) => ({
                    key, version: count === 100 && index === 0 ? 1 : 0,
                    value: count === 100 ? null : bytes.toString("base64"),
                })), { supportsCurrentProtocol: true });
                return { result, reads: observed.reads, rows: observed.rows };
            });
            expect(result.result.success).toBe(true);
            expect(await db.accountChange.count({ where: { accountId: reader.id, kind: "kv" } })).toBe(count);
            costs.push(result.reads.length);
            expect(result.rows.every(row => row.count <= count)).toBe(true);
        }
        expect(costs[1]).toBeLessThanOrEqual(costs[0]!);
        // One admission census, one CAS set read and one current publication census.
        expect(costs.every(count => count <= 3)).toBe(true);
        console.info("TASK_RAW_KV_READ_COST", JSON.stringify({ changedTasks: [1, 100], reads: costs }));
        expect(await db.userKVStore.count({ where: { accountId: owner.id, value: { not: null } } })).toBe(0);
    });
});
