import { randomUUID } from "node:crypto";
import { SessionOrganizationSnapshotResponseSchema } from "@happier-dev/protocol/sessions/organization/snapshot";
import { AccountEncryptionMigrateSessionOrganizationDirectiveSchema } from "@happier-dev/protocol/account/encryptionMigrate";
import { ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from "@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerSessionOrganizationRoutes } from "@/app/api/routes/session/registerSessionOrganizationRoutes";
import { createRouteTestBuilder } from "@/app/api/testkit/routeTestBuilder";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import type { Fastify } from "@/app/api/types";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireSessionOrganizationMutationAdmissionInTx } from './changes';
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    readSessionOrganizationAccountEncryptionMigrationInventoryInTx,
    migrateSessionOrganizationAccountEncryptionInTx,
    matchSessionOrganizationAccountEncryptionMigrationPostStateInTx,
} from "./sessionOrganizationAccountEncryptionMigration";

const plainDisplay = { t: "plain" as const, v: { color: { kind: "custom", hex: "#123456" }, extra: [true, 1] } };
const encryptedDisplay = { t: "encrypted" as const, c: "opaque-ciphertext" };

function route(method: "PUT" | "GET" = "PUT") {
    return createRouteTestBuilder({ method,
        path: method === "PUT" ? "/v2/session-organization/appearances/:sessionId" : "/v2/session-organization",
        registerRoutes(app) { registerSessionOrganizationRoutes(app as unknown as Fastify); },
    });
}

async function createAccountWithSession(encryptionMode: "plain" | "e2ee" = "plain") {
    const account = await db.account.create({ data: {
        encryptionMode,
        ...(encryptionMode === "e2ee" ? createSignedAccountContentBinding() : {}),
    } });
    const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
    return { accountId: account.id, sessionId: session.id };
}

describe("session appearances on SQLite", () => {
    let harness: LightSqliteHarness;
    const app = createAuthenticatedTestApp({ authentication: "real" }) as Fastify;
    let origin: string;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-session-appearance-", initAuth: true });
        registerSessionOrganizationRoutes(app);
        origin = await app.listen({ host: "127.0.0.1", port: 0 });
    });
    beforeEach(() => { harness.resetEnv(); });
    afterAll(async () => { await app.close(); await harness?.close(); });

    it("stores one opaque display, updates it, and only publishes actual changes", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const put = route();
        const request = { userId: accountId, params: { sessionId }, body: { display: plainDisplay } };
        const created = await put.invoke(request);
        expect(created.reply.statusCode).toBe(200);
        expect(created.response).toEqual({ appearance: { sessionId, display: plainDisplay, updatedAt: expect.any(Number) } });
        expect((await put.invoke(request)).response).toEqual(created.response);
        await expect(db.sessionOrganizationCheckpoint.findUnique({ where: { accountId }, select: { version: true } }))
            .resolves.toEqual({ version: 1 });
        await expect(db.accountChange.findFirst({ where: { accountId, entityId: "session-organization" }, select: { hint: true } }))
            .resolves.toEqual({ hint: { sessionOrganization: true, scope: "sessionAppearances", sessionIds: [sessionId] } });
        const changed = await put.invoke({ ...request, body: { display: { t: "plain", v: { color: "other" } } } });
        expect(changed.reply.statusCode).toBe(200);
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(1);
        for (let i = 0; i < 2; i += 1) {
            expect((await put.invoke({ ...request, body: { display: null } })).response).toEqual({ appearance: null });
        }
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(0);
        await expect(db.sessionOrganizationCheckpoint.findUnique({ where: { accountId }, select: { version: true } }))
            .resolves.toEqual({ version: 3 });
    });

    it("negotiates snapshots and malformed-body errors through authenticated HTTP", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const headers = { authorization: `Bearer ${await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" })}`, "content-type": "application/json" };
        const put = (body: unknown) => fetch(`${origin}/v2/session-organization/appearances/${sessionId}`, {
            method: "PUT", headers, body: JSON.stringify(body),
        });
        expect((await put({ display: plainDisplay })).status).toBe(200);
        const read = async (query: string) => {
            const response = await fetch(`${origin}/v2/session-organization${query}`, { headers });
            expect(response.status).toBe(200);
            return SessionOrganizationSnapshotResponseSchema.parse(await response.json()).snapshot;
        };
        expect(await read("")).not.toHaveProperty("sessionAppearances");
        expect((await read("?includeSessionAppearances=true")).sessionAppearances)
            .toEqual([{ sessionId, display: plainDisplay, updatedAt: expect.any(Number) }]);
        const invalid = await put({ display: { t: "encrypted" } });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ error: "invalid-params" });
        await db.sessionAppearance.update({ where: { accountId_sessionId: { accountId, sessionId } }, data: { displayDbValue: "{invalid-json" } });
        const url = `${origin}/v2/session-organization?includeSessionAppearances=true`;
        expect((await fetch(url, { headers })).status).toBe(426);
        const current = await fetch(url, { headers: { ...headers,
            [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
        } });
        expect(current.status).toBe(200);
        expect(SessionOrganizationSnapshotResponseSchema.parse(await current.json()).snapshot.sessionAppearances)
            .toEqual([{ sessionId, updatedAt: expect.any(Number), display: null,
                displayState: { status: "unavailable", reason: "invalid_stored_display" } }]);
        expect((await put({ display: null })).status).toBe(200);
    });

    it("enforces visibility and Account envelope mode, while archived rows remain clearable", async () => {
        for (const encryptionMode of ["plain", "e2ee"] as const) {
            const { accountId, sessionId } = await createAccountWithSession(encryptionMode);
            const other = await createAccountWithSession();
            const display = encryptionMode === "plain" ? plainDisplay : encryptedDisplay;
            const wrongDisplay = encryptionMode === "plain" ? encryptedDisplay : plainDisplay;
            const put = route();
            expect((await put.invoke({ userId: accountId, params: { sessionId }, body: { display: wrongDisplay } })).reply.statusCode).toBe(400);
            expect((await put.invoke({ userId: accountId, params: { sessionId }, body: { display } })).reply.statusCode).toBe(200);
            for (const inaccessibleDisplay of [display, null]) {
                expect((await put.invoke({ userId: other.accountId, params: { sessionId }, body: { display: inaccessibleDisplay } })).reply.statusCode).toBe(404);
            }
            await db.session.update({ where: { id: sessionId }, data: { archivedAt: new Date() } });
            expect((await put.invoke({ userId: accountId, params: { sessionId }, body: { display } })).reply.statusCode).toBe(404);
            const snapshot = await route("GET").invoke({ userId: accountId, query: { includeSessionAppearances: "true" } });
            expect(SessionOrganizationSnapshotResponseSchema.parse(snapshot.response).snapshot.sessionAppearances).toEqual([]);
            expect((await put.invoke({ userId: accountId, params: { sessionId }, body: { display: null } })).reply.statusCode).toBe(200);
        }
    });

    it("bounds visible rows while allowing updates, clearing, and archiving to free quota", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const ids = Array.from({ length: 1_000 }, () => randomUUID());
        await db.session.createMany({ data: ids.map(id => ({ id, accountId, tag: id, metadata: "{}" })) });
        await db.sessionAppearance.createMany({ data: ids.map(id => ({ accountId, sessionId: id, displayDbValue: JSON.stringify(plainDisplay) })) });
        const put = route();
        const rejected = await put.invoke({ userId: accountId, params: { sessionId }, body: { display: plainDisplay } });
        expect(rejected.reply.statusCode).toBe(409);
        expect(rejected.response).toEqual({ error: "session-appearance-limit-exceeded" });
        expect((await put.invoke({ userId: accountId, params: { sessionId: ids[0] }, body: { display: plainDisplay } })).reply.statusCode).toBe(200);
        expect((await put.invoke({ userId: accountId, params: { sessionId: ids[0] }, body: { display: null } })).reply.statusCode).toBe(200);
        expect((await put.invoke({ userId: accountId, params: { sessionId }, body: { display: plainDisplay } })).reply.statusCode).toBe(200);
        const snapshot = await route("GET").invoke({ userId: accountId, query: { includeSessionAppearances: "true" } });
        expect(SessionOrganizationSnapshotResponseSchema.parse(snapshot.response).snapshot.sessionAppearances).toHaveLength(1_000);
        await db.session.updateMany({ where: { accountId, id: { not: sessionId } }, data: { archivedAt: new Date() } });
        const nextSession = await db.session.create({ data: { accountId, tag: randomUUID(), metadata: "{}" } });
        const next = await put.invoke({ userId: accountId, params: { sessionId: nextSession.id }, body: { display: plainDisplay } });
        expect(next.reply.statusCode).toBe(200);
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(1_001);
        const visible = await route("GET").invoke({ userId: accountId, query: { includeSessionAppearances: "true" } });
        expect(SessionOrganizationSnapshotResponseSchema.parse(visible.response).snapshot.sessionAppearances?.map(row => row.sessionId).sort())
            .toEqual([sessionId, nextSession.id].sort());
    });

    it("cascades session and account deletion using the existing ownership FKs", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        await route().invoke({ userId: accountId, params: { sessionId }, body: { display: plainDisplay } });
        await db.session.delete({ where: { id: sessionId } });
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(0);
        const remaining = await createAccountWithSession();
        const otherAccount = await db.account.create({ data: { encryptionMode: "plain" } });
        await db.sessionAppearance.create({ data: { accountId: otherAccount.id, sessionId: remaining.sessionId, displayDbValue: JSON.stringify(plainDisplay) } });
        await db.account.delete({ where: { id: otherAccount.id } });
        await expect(db.sessionAppearance.count({ where: { accountId: otherAccount.id } })).resolves.toBe(0);
        await expect(db.session.findUnique({ where: { id: remaining.sessionId }, select: { id: true } })).resolves.toEqual({ id: remaining.sessionId });
    });

    it("converts all 1,001 retained appearances including an archived session and matches replay", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        await route().invoke({ userId: accountId, params: { sessionId }, body: { display: plainDisplay } });
        const retainedIds = Array.from({ length: 1_000 }, () => randomUUID());
        const archivedAt = new Date();
        await db.session.createMany({ data: retainedIds.map((id, index) => ({
            id, accountId, tag: id, metadata: "{}", archivedAt: index === 0 ? archivedAt : null,
        })) });
        await db.sessionAppearance.createMany({ data: retainedIds.map(id => ({
            accountId, sessionId: id, displayDbValue: JSON.stringify(plainDisplay),
        })) });
        await inTx(async tx => {
            await acquireSessionOrganizationMutationAdmissionInTx(tx, accountId);
            expect(await migrateSessionOrganizationAccountEncryptionInTx({ tx, accountId, toMode: "e2ee", directive: { action: "assert_empty" } }))
                .toEqual({ status: "not_empty" });
            const inventory = await readSessionOrganizationAccountEncryptionMigrationInventoryInTx({ tx, accountId });
            expect(inventory.sessionAppearances).toHaveLength(1_001);
            expect(inventory.sessionAppearances).toEqual(expect.arrayContaining([{ sessionId: retainedIds[0], display: plainDisplay }]));
            const directive = AccountEncryptionMigrateSessionOrganizationDirectiveSchema.parse({ action: "migrate", expectedVersion: inventory.version,
                folders: [], tags: [], labels: [], sessionAppearances: inventory.sessionAppearances?.map(row => ({
                    sessionId: row.sessionId, expectedDisplay: row.display, display: encryptedDisplay,
                })) });
            expect(await migrateSessionOrganizationAccountEncryptionInTx({ tx, accountId, toMode: "e2ee", directive })).toEqual({ status: "applied" });
            expect(await matchSessionOrganizationAccountEncryptionMigrationPostStateInTx({ tx, accountId, toMode: "e2ee", directive }))
                .toEqual({ status: "matched" });
        });
        await expect(db.sessionAppearance.findUnique({ where: { accountId_sessionId: { accountId, sessionId } }, select: { displayDbValue: true } }))
            .resolves.toEqual({ displayDbValue: JSON.stringify(encryptedDisplay) });
        await expect(db.sessionAppearance.count({ where: { accountId, displayDbValue: JSON.stringify(encryptedDisplay) } })).resolves.toBe(1_001);
        await expect(db.session.findUnique({ where: { id: retainedIds[0] }, select: { archivedAt: true } })).resolves.toEqual({ archivedAt });
    });
});
