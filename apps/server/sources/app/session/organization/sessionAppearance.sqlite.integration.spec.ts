import { randomUUID } from "node:crypto";

import FastifyApp from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { SessionOrganizationSnapshotResponseSchema } from "@happier-dev/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerSessionOrganizationRoutes } from "@/app/api/routes/session/registerSessionOrganizationRoutes";
import { createRouteTestBuilder } from "@/app/api/testkit/routeTestBuilder";
import type { Fastify } from "@/app/api/types";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

function appearanceRoute() {
    return createRouteTestBuilder({
        method: "PUT",
        path: "/v2/session-organization/appearances/:sessionId",
        registerRoutes(app) { registerSessionOrganizationRoutes(app as unknown as Fastify); },
    });
}

function snapshotRoute() {
    return createRouteTestBuilder({
        method: "GET",
        path: "/v2/session-organization",
        registerRoutes(app) { registerSessionOrganizationRoutes(app as unknown as Fastify); },
    });
}

async function createAccountWithSession(encryptionMode: "plain" | "e2ee" = "e2ee") {
    const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode } });
    const session = await db.session.create({ data: {
        accountId: account.id, tag: `session-${randomUUID()}`, metadata: "{}", metadataVersion: 0,
        agentState: null, agentStateVersion: 0,
    } });
    return { accountId: account.id, sessionId: session.id };
}

const encryptedDisplay = { t: "encrypted" as const, c: "opaque-ciphertext" };
const plainDisplay = { t: "plain" as const, v: { color: "#123456", arbitrary: [1, true] } };

describe("session appearances on SQLite", () => {
    let harness: LightSqliteHarness;
    let origin: string;
    const app = FastifyApp({ logger: false }).withTypeProvider<ZodTypeProvider>();
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-appearance-sqlite-", initAuth: true, initEncrypt: false, initFiles: false,
        });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        enableErrorHandlers(app);
        registerSessionOrganizationRoutes(app);
        origin = await app.listen({ host: "127.0.0.1", port: 0 });
    });
    beforeEach(() => { harness.resetEnv(); });
    afterAll(async () => { await app.close(); await harness?.close(); });

    it("round-trips appearances over authenticated HTTP and preserves the published error response", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const headers = { authorization: `Bearer ${await auth.createToken(accountId)}`, "content-type": "application/json" };
        const put = (body: unknown) => fetch(`${origin}/v2/session-organization/appearances/${sessionId}`, {
            method: "PUT", headers, body: JSON.stringify(body),
        });
        const written = await put({ display: encryptedDisplay });
        expect(written.status).toBe(200);
        expect(await written.json()).toEqual({ appearance: { sessionId, display: encryptedDisplay, updatedAt: expect.any(Number) } });
        const legacy = await fetch(`${origin}/v2/session-organization`, { headers });
        expect(legacy.status).toBe(200);
        expect(SessionOrganizationSnapshotResponseSchema.parse(await legacy.json()).snapshot).not.toHaveProperty("sessionAppearances");
        const modern = await fetch(`${origin}/v2/session-organization?includeSessionAppearances=true`, { headers });
        expect(modern.status).toBe(200);
        expect(SessionOrganizationSnapshotResponseSchema.parse(await modern.json()).snapshot.sessionAppearances)
            .toEqual([{ sessionId, display: encryptedDisplay, updatedAt: expect.any(Number) }]);
        const invalid = await put({ display: { t: "encrypted" } });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ error: "invalid-params" });
        const cleared = await put({ display: null });
        expect(cleared.status).toBe(200);
        expect(await cleared.json()).toEqual({ appearance: null });
    });

    it("round-trips opaque displays, updates one row, clears idempotently, and publishes changes", async () => {
        const { accountId, sessionId } = await createAccountWithSession("plain");
        const route = appearanceRoute();
        for (const display of [encryptedDisplay, plainDisplay]) {
            const result = await route.invoke({ userId: accountId, params: { sessionId }, body: { display } });
            expect(result.reply.statusCode).toBe(200);
            expect(result.response).toEqual({ appearance: { sessionId, display, updatedAt: expect.any(Number) } });
        }
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(1);
        await expect(db.sessionOrganizationCheckpoint.findUnique({ where: { accountId }, select: { version: true } }))
            .resolves.toEqual({ version: 2 });
        await expect(db.accountChange.findFirst({
            where: { accountId, entityId: "session-organization" }, select: { hint: true },
        })).resolves.toEqual({ hint: { sessionOrganization: true, scope: "sessionAppearances", sessionIds: [sessionId] } });
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = await route.invoke({ userId: accountId, params: { sessionId }, body: { display: null } });
            expect(result.reply.statusCode).toBe(200);
            expect(result.response).toEqual({ appearance: null });
        }
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(0);
    });

    it("only includes appearances when requested and filters archived and inaccessible sessions", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        await appearanceRoute().invoke({ userId: accountId, params: { sessionId }, body: { display: encryptedDisplay } });
        const route = snapshotRoute();
        const without = (await route.invoke({ userId: accountId })).response;
        expect(SessionOrganizationSnapshotResponseSchema.parse(without).snapshot).not.toHaveProperty("sessionAppearances");
        const withFlag = SessionOrganizationSnapshotResponseSchema.parse((await route.invoke({
            userId: accountId, query: { includeSessionAppearances: "true" },
        })).response);
        expect(withFlag.snapshot.sessionAppearances).toEqual([{ sessionId, display: encryptedDisplay, updatedAt: expect.any(Number) }]);
        const other = await createAccountWithSession();
        expect(SessionOrganizationSnapshotResponseSchema.parse((await route.invoke({
            userId: other.accountId, query: { includeSessionAppearances: "true" },
        })).response).snapshot.sessionAppearances).toEqual([]);
        await db.session.update({ where: { id: sessionId }, data: { archivedAt: new Date() } });
        expect(SessionOrganizationSnapshotResponseSchema.parse((await route.invoke({
            userId: accountId, query: { includeSessionAppearances: "true" },
        })).response).snapshot.sessionAppearances).toEqual([]);
    });

    it("refuses inaccessible writes and allows clearing archived sessions", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const other = await createAccountWithSession();
        const route = appearanceRoute();
        for (const display of [encryptedDisplay, null]) {
            const rejected = await route.invoke({ userId: other.accountId, params: { sessionId }, body: { display } });
            expect(rejected.reply.statusCode).toBe(404);
            expect(rejected.response).toEqual({ error: "Session not found" });
        }
        await route.invoke({ userId: accountId, params: { sessionId }, body: { display: encryptedDisplay } });
        await db.session.update({ where: { id: sessionId }, data: { archivedAt: new Date() } });
        expect((await route.invoke({ userId: accountId, params: { sessionId }, body: { display: encryptedDisplay } })).reply.statusCode).toBe(404);
        expect((await route.invoke({ userId: accountId, params: { sessionId }, body: { display: null } })).response).toEqual({ appearance: null });
    });

    it("cascades session deletion", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        await appearanceRoute().invoke({ userId: accountId, params: { sessionId }, body: { display: encryptedDisplay } });
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(1);
        await db.session.delete({ where: { id: sessionId } });
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(0);
    });

    it("cascades account deletion through the same ownership FK as pins and attention standings", async () => {
        const { sessionId } = await createAccountWithSession();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        // Isolate the organization rows' account FKs: an account that owns a Session cannot be
        // deleted directly because the existing Session.account relation uses RESTRICT.
        await db.sessionAppearance.create({ data: {
            accountId: account.id, sessionId, displayDbValue: JSON.stringify(encryptedDisplay),
        } });
        await db.sessionPin.create({ data: { accountId: account.id, sessionId } });
        await db.sessionAttentionStanding.create({ data: { accountId: account.id, sessionId, standing: true } });
        await db.account.delete({ where: { id: account.id } });
        await expect(db.sessionAppearance.count({ where: { accountId: account.id } })).resolves.toBe(0);
        await expect(db.sessionPin.count({ where: { accountId: account.id } })).resolves.toBe(0);
        await expect(db.sessionAttentionStanding.count({ where: { accountId: account.id } })).resolves.toBe(0);
        await expect(db.session.findUnique({ where: { id: sessionId }, select: { id: true } })).resolves.toEqual({ id: sessionId });
    });

    it("rejects creation past the visible bound while allowing updates, clear, and archiving to free quota", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const ids = Array.from({ length: 1_000 }, () => randomUUID());
        await db.session.createMany({ data: ids.map((id) => ({
            id, accountId, tag: id, metadata: "{}", metadataVersion: 0, agentStateVersion: 0,
        })) });
        await db.sessionAppearance.createMany({ data: ids.map((id) => ({
            accountId, sessionId: id, displayDbValue: JSON.stringify(encryptedDisplay),
        })) });
        const route = appearanceRoute();
        const rejected = await route.invoke({ userId: accountId, params: { sessionId }, body: { display: encryptedDisplay } });
        expect(rejected.reply.statusCode).toBe(409);
        expect(rejected.response).toEqual({ error: "session-appearance-limit-exceeded" });
        const updated = await route.invoke({ userId: accountId, params: { sessionId: ids[0] }, body: { display: encryptedDisplay } });
        expect(updated.reply.statusCode).toBe(200);
        const full = SessionOrganizationSnapshotResponseSchema.parse((await snapshotRoute().invoke({
            userId: accountId, query: { includeSessionAppearances: "true" },
        })).response);
        expect(full.snapshot.sessionAppearances).toHaveLength(1_000);
        await route.invoke({ userId: accountId, params: { sessionId: ids[0] }, body: { display: null } });
        expect((await route.invoke({ userId: accountId, params: { sessionId }, body: { display: encryptedDisplay } })).reply.statusCode).toBe(200);
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(1_000);
        await db.session.updateMany({ where: { accountId, id: { not: sessionId } }, data: { archivedAt: new Date() } });
        const nextSession = await db.session.create({ data: { accountId, tag: randomUUID(), metadata: "{}" } });
        const next = await route.invoke({ userId: accountId, params: { sessionId: nextSession.id }, body: { display: encryptedDisplay } });
        expect(next.reply.statusCode).toBe(200);
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(1_001);
        const visible = SessionOrganizationSnapshotResponseSchema.parse((await snapshotRoute().invoke({
            userId: accountId, query: { includeSessionAppearances: "true" },
        })).response);
        expect(visible.snapshot.sessionAppearances?.map(row => row.sessionId).sort()).toEqual([sessionId, nextSession.id].sort());
    });

    it("rejects malformed envelopes and plaintext for encrypted accounts without storing content", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        for (const body of [{}, { display: { t: "encrypted" } }, { display: encryptedDisplay, extra: true }, { display: plainDisplay }]) {
            const result = await appearanceRoute().invoke({ userId: accountId, params: { sessionId }, body });
            expect(result.reply.statusCode).toBe(400);
            expect(result.response).toEqual({ error: "invalid-session-appearance" });
        }
        await expect(db.sessionAppearance.count({ where: { accountId } })).resolves.toBe(0);
    });
});
