import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionOrganizationSnapshotResponseSchema } from "@happier-dev/protocol/sessions/organization/snapshot";
import { db, initDbPostgres } from "@/storage/db";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { observePrismaRequests } from "@/testkit/observeSqliteRequests";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionOrganizationRoutes } from "@/app/api/routes/session/registerSessionOrganizationRoutes";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Session appearances PostgreSQL contract", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("returns the full first-paint corpus and publishes only changed appearance facts", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const sessionIds = Array.from({ length: 1_000 }, () => randomUUID());
        const display = { t: "plain", v: { color: "violet" } };
        const app = createAuthenticatedTestApp();
        registerSessionOrganizationRoutes(app);
        await app.ready();
        const headers = { "x-test-user-id": account.id };
        try {
            await db.session.createMany({ data: sessionIds.map(id => ({ id, accountId: account.id, tag: id, metadata: "{}" })) });
            await db.sessionAppearance.createMany({ data: sessionIds.map(sessionId => ({ accountId: account.id, sessionId, displayDbValue: JSON.stringify(display) })) });
            const snapshot = await app.inject({ method: "GET", url: "/v2/session-organization?includeSessionAppearances=true", headers });
            expect(snapshot.statusCode).toBe(200);
            expect(SessionOrganizationSnapshotResponseSchema.parse(snapshot.json()).snapshot.sessionAppearances).toHaveLength(1_000);
            const url = `/v2/session-organization/appearances/${sessionIds[0]}`;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const response = await app.inject({ method: "PUT", url, headers, payload: { display: { t: "plain", v: { color: "teal" } } } });
                expect(response.statusCode).toBe(200);
            }
            expect(await db.sessionOrganizationCheckpoint.findUnique({ where: { accountId: account.id }, select: { version: true } })).toEqual({ version: 1 });
            const clear = await app.inject({ method: "PUT", url, headers, payload: { display: null } });
            expect(clear.statusCode).toBe(200);
            expect(await db.sessionAppearance.count({ where: { accountId: account.id } })).toBe(999);
        } finally {
            await app.close();
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("reads the viewer's Session access facts once per snapshot and per new appearance", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const ownSessionIds = Array.from({ length: 20 }, () => randomUUID());
        const sharedSessionId = randomUUID();
        const app = createAuthenticatedTestApp();
        registerSessionOrganizationRoutes(app);
        await app.ready();
        const headers = { "x-test-user-id": viewer.id };
        // Count the real Prisma requests per route call; all IO stays real.
        const reads = { directShares: 0, memberships: 0 };
        const measure = async <T>(run: () => T): Promise<Awaited<T>> => {
            reads.directShares = 0;
            reads.memberships = 0;
            const stop = observePrismaRequests(db, { before(request) {
                if (request.action !== "findMany") return;
                if (request.model === "SessionGrant") reads.directShares += 1;
                if (request.model === "TeamMembership") reads.memberships += 1;
            } });
            try { return await run(); } finally { stop(); }
        };
        try {
            await db.session.createMany({ data: [
                ...ownSessionIds.map(id => ({ id, accountId: viewer.id, tag: id, metadata: "{}" })),
                { id: sharedSessionId, accountId: owner.id, tag: sharedSessionId, metadata: "{}" },
            ] });
            await db.sessionGrant.create({ data: { sessionId: sharedSessionId, principalKind: "account", accountId: viewer.id,
                createdByAccountId: owner.id, accessLevel: "view" } });

            const snapshot = await measure(() => app.inject({ method: "GET", url: "/v2/session-organization?includeSessionAppearances=true", headers }));
            expect(snapshot.statusCode).toBe(200);
            expect(reads).toEqual({ directShares: 1, memberships: 1 });

            const created = await measure(() => app.inject({ method: "PUT", url: `/v2/session-organization/appearances/${sharedSessionId}`, headers,
                payload: { display: { t: "plain", v: { color: "teal" } } } }));
            expect(created.statusCode).toBe(200);
            expect(created.json().appearance).toMatchObject({ sessionId: sharedSessionId });
            // One decision inside the mutation transaction, shared by the target check and the
            // appearance-limit count; the route runs no separate admission transaction.
            expect(reads).toEqual({ directShares: 1, memberships: 1 });

            // A Session the viewer cannot read stays refused.
            const foreign = randomUUID();
            await db.session.create({ data: { id: foreign, accountId: owner.id, tag: foreign, metadata: "{}" } });
            const refused = await app.inject({ method: "PUT", url: `/v2/session-organization/appearances/${foreign}`, headers,
                payload: { display: { t: "plain", v: { color: "teal" } } } });
            expect(refused.statusCode).toBe(404);
        } finally {
            await app.close();
            await db.sessionAppearance.deleteMany({ where: { accountId: viewer.id } });
            await db.sessionGrant.deleteMany({ where: { sessionId: sharedSessionId } });
            await db.session.deleteMany({ where: { accountId: { in: [viewer.id, owner.id] } } });
            await db.account.deleteMany({ where: { id: { in: [viewer.id, owner.id] } } });
        }
    });

    it("decides Session access once per organization gesture, including clears, and still refuses a foreign Session", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const sharedSessionId = randomUUID();
        const foreignSessionId = randomUUID();
        const app = createAuthenticatedTestApp();
        registerSessionOrganizationRoutes(app);
        await app.ready();
        const headers = { "x-test-user-id": viewer.id };
        const reads = { directShares: 0, memberships: 0 };
        const measure = async (method: "PUT", url: string, payload: unknown) => {
            reads.directShares = 0;
            reads.memberships = 0;
            // Access decisions read the viewer's own grants and memberships; the cursor lock's
            // Session-audience read (all recipients of the Session) is not an access decision.
            const stop = observePrismaRequests(db, { before(request) {
                if (request.action !== "findMany" || !JSON.stringify(request.args).includes(viewer.id)) return;
                if (request.model === "SessionGrant") reads.directShares += 1;
                if (request.model === "TeamMembership") reads.memberships += 1;
            } });
            try { return await app.inject({ method, url, headers, payload }); } finally { stop(); }
        };
        try {
            await db.session.createMany({ data: [
                { id: sharedSessionId, accountId: owner.id, tag: sharedSessionId, metadata: "{}" },
                { id: foreignSessionId, accountId: owner.id, tag: foreignSessionId, metadata: "{}" },
            ] });
            await db.sessionGrant.create({ data: { sessionId: sharedSessionId, principalKind: "account", accountId: viewer.id,
                createdByAccountId: owner.id, accessLevel: "view" } });
            const gestures: ReadonlyArray<readonly [string, unknown]> = [
                ["pins", { pinned: true }],
                ["pins", { pinned: false }],
                ["attention-standings", { standing: true }],
                ["attention-standings", { standing: null }],
                ["appearances", { display: { t: "plain", v: { color: "teal" } } }],
                ["appearances", { display: null }],
                ["tag-assignments", { tagIds: [] }],
            ];
            for (const [route, payload] of gestures) {
                const response = await measure("PUT", `/v2/session-organization/${route}/${sharedSessionId}`, payload);
                expect({ route, payload, status: response.statusCode }).toEqual({ route, payload, status: 200 });
                expect({ route, payload, ...reads }).toEqual({ route, payload, directShares: 1, memberships: 1 });
            }
            for (const [route, payload] of gestures) {
                const refused = await app.inject({ method: "PUT", url: `/v2/session-organization/${route}/${foreignSessionId}`, headers, payload });
                expect({ route, payload, status: refused.statusCode }).toEqual({ route, payload, status: 404 });
            }
        } finally {
            await app.close();
            await db.sessionPin.deleteMany({ where: { accountId: viewer.id } });
            await db.sessionAttentionStanding.deleteMany({ where: { accountId: viewer.id } });
            await db.sessionAppearance.deleteMany({ where: { accountId: viewer.id } });
            await db.sessionGrant.deleteMany({ where: { sessionId: sharedSessionId } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.deleteMany({ where: { id: { in: [viewer.id, owner.id] } } });
        }
    });
});
