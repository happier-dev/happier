import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionOrganizationSnapshotResponseSchema } from "@happier-dev/protocol/sessions/organization/snapshot";
import { db, initDbPostgres } from "@/storage/db";
import { getDbProviderFromEnv } from "@/storage/prisma";
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
});
