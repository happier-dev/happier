import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealAccountScopedBlobCiphertext } from "@happier-dev/protocol";

import type { Fastify as ServerFastify } from "@/app/api/types";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { accountRoutes } from "./accountRoutes";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { kvRoutes } from "../kv/kvRoutes";

function createTestApp() {
    const app = createAuthenticatedTestApp() as ServerFastify;
    accountRoutes(app as unknown as ServerFastify);
    kvRoutes(app);
    return app;
}

describe("Account authoring-memory reserved rows", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-authoring-memory-" });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("reads additive stored envelope fields without admitting them in new mutations", async () => {
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: "plain" } });
        const key = "@happier/account/authoring-memory/v1/lastUsedProfile";
        const bytes = new TextEncoder().encode(JSON.stringify({ t: "plain", v: "profile", futureEnvelopeField: true }));
        await db.userKVStore.create({ data: { accountId: account.id, key, version: 0, value: bytes } });
        const app = createTestApp();
        try {
            const headers = { "x-test-user-id": account.id };
            const url = "/v1/account/authoring-memory/lastUsedProfile";
            expect((await app.inject({ method: "GET", url, headers })).json()).toEqual({
                status: "present", revision: 0, content: { t: "plain", v: "profile" },
            });
            expect((await app.inject({ method: "GET", url: "/v1/account/authoring-memory", headers })).json()).toEqual({
                rows: [{ key: "lastUsedProfile", revision: 0, content: { t: "plain", v: "profile" } }],
            });
            expect((await app.inject({ method: "POST", url, headers, payload: {
                expectedRevision: 0, content: { t: "plain", v: "new-profile", futureEnvelopeField: true },
            } })).statusCode).toBe(400);
            expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).value).toEqual(bytes);
        } finally { await app.close(); }
    });

    it("reads, lists and CAS-mutates plain rows without losing opaque values, isolating Accounts and tombstones", async () => {
        const owner = await db.account.create({ data: { id: randomUUID(), encryptionMode: "plain" } });
        const other = await db.account.create({ data: { id: randomUUID(), encryptionMode: "plain" } });
        const app = createTestApp();
        try {
            const headers = { "x-test-user-id": owner.id };
            const path = "/v1/account/authoring-memory/engineSelection:default:agent:codex";
            const content = { t: "plain", v: { v: 1, modelSelection: { ref: { opaque: { future: [1, null] } } }, updatedAt: 4 } };
            expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
            expect((await app.inject({ method: "GET", url: path, headers })).json()).toEqual({ status: "absent" });
            const written = await app.inject({ method: "POST", url: path, headers, payload: { expectedRevision: "absent", content } });
            expect(written.statusCode).toBe(200);
            expect(written.json()).toMatchObject({ status: "updated", revision: 0 });
            expect((await app.inject({ method: "GET", url: path, headers })).json()).toEqual({ status: "present", revision: 0, content });
            expect((await app.inject({ method: "GET", url: path, headers: { "x-test-user-id": other.id } })).json()).toEqual({ status: "absent" });
            expect((await app.inject({ method: "POST", url: path, headers, payload: { expectedRevision: "absent", content: null } })).json()).toEqual({ status: "conflict", revision: 0 });
            expect((await app.inject({ method: "GET", url: "/v1/account/authoring-memory", headers })).json()).toEqual({ rows: [{ key: "engineSelection:default:agent:codex", revision: 0, content }] });
            const hint = await db.accountChange.findFirstOrThrow({ where: { accountId: owner.id, kind: "account" } });
            expect(hint.hint).toEqual({ authoringMemory: true, key: "engineSelection:default:agent:codex", revision: 0 });
            const physicalKey = "@happier/account/authoring-memory/v1/engineSelection:default:agent:codex";
            for (const request of [
                { method: "GET" as const, url: `/v1/kv/${encodeURIComponent(physicalKey)}` },
                { method: "GET" as const, url: "/v1/kv?prefix=%40happier" },
                { method: "POST" as const, url: "/v1/kv/bulk", payload: { keys: [physicalKey] } },
                { method: "POST" as const, url: "/v1/kv", payload: { mutations: [{ key: physicalKey, value: null, version: 0 }] } },
            ]) {
                const response = await app.inject({ ...request, headers });
                expect(response.statusCode).toBe(400);
                expect(response.body).not.toContain("opaque");
            }
            expect((await app.inject({ method: "POST", url: path, headers, payload: { expectedRevision: 0, content: null } })).json()).toMatchObject({ status: "updated", revision: 1 });
            expect((await app.inject({ method: "GET", url: path, headers })).json()).toEqual({ status: "deleted", revision: 1 });
            expect((await app.inject({ method: "GET", url: "/v1/account/authoring-memory", headers })).json()).toEqual({ rows: [{ key: "engineSelection:default:agent:codex", revision: 1, content: null }] });
        } finally { await app.close(); }
    });

    it("admits only the Account's persisted encryption mode and authoring-memory cipher purpose", async () => {
        const plain = await db.account.create({ data: { id: randomUUID(), encryptionMode: "plain" } });
        const encrypted = await db.account.create({ data: { id: randomUUID(), encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const material = { type: "dataKey" as const, machineKey: new Uint8Array(32).fill(41) };
        const app = createTestApp();
        try {
            const path = "/v1/account/authoring-memory/lastUsedProfile";
            const encryptedContent = { t: "encrypted", c: sealAccountScopedBlobCiphertext({
                kind: "authoring_memory",
                material, payload: { key: "lastUsedProfile", value: "profile-1" }, randomBytes: length => new Uint8Array(length).fill(7),
            }) };
            for (const [accountId, content] of [[plain.id, encryptedContent], [encrypted.id, { t: "plain", v: "profile-1" }], [encrypted.id, { t: "encrypted", c: sealAccountScopedBlobCiphertext({ kind: "account_settings", material, payload: "profile-1", randomBytes: length => new Uint8Array(length).fill(8) }) }]] as const) {
                const refused = await app.inject({ method: "POST", url: path, headers: { "x-test-user-id": accountId }, payload: { expectedRevision: "absent", content } });
                expect(refused.statusCode).toBe(503);
                expect(await db.userKVStore.count({ where: { accountId } })).toBe(0);
            }
            const headers = { "x-test-user-id": encrypted.id };
            const write = await app.inject({ method: "POST", url: path, headers, payload: { expectedRevision: "absent", content: encryptedContent } });
            expect(write.statusCode).toBe(200);
            expect((await app.inject({ method: "GET", url: path, headers })).json()).toEqual({ status: "present", revision: 0, content: encryptedContent });
        } finally { await app.close(); }
    });

    it("does not disclose or overwrite a stored envelope that contradicts Account mode", async () => {
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const physicalKey = "@happier/account/authoring-memory/v1/lastUsedProfile";
        const bytes = new TextEncoder().encode(JSON.stringify({ t: "plain", v: "must-remain-private" }));
        await db.userKVStore.create({ data: { accountId: account.id, key: physicalKey, version: 7, value: bytes } });
        const app = createTestApp();
        try {
            const headers = { "x-test-user-id": account.id };
            for (const request of [
                { method: "GET" as const, url: "/v1/account/authoring-memory/lastUsedProfile" },
                { method: "GET" as const, url: "/v1/account/authoring-memory" },
                { method: "POST" as const, url: "/v1/account/authoring-memory/lastUsedProfile", payload: { expectedRevision: 7, content: null } },
            ]) {
                const response = await app.inject({ ...request, headers });
                expect(response.statusCode).toBe(503);
                expect(response.body).not.toContain("must-remain-private");
            }
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: physicalKey } } })).toMatchObject({ version: 7, value: bytes });
        } finally { await app.close(); }
    });
});
