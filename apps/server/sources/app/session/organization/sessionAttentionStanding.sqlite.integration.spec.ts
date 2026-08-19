import { randomUUID } from "node:crypto";

import { SessionOrganizationSnapshotResponseSchema } from "@happier-dev/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerSessionOrganizationRoutes } from "@/app/api/routes/session/registerSessionOrganizationRoutes";
import { createRouteTestBuilder } from "@/app/api/testkit/routeTestBuilder";
import type { Fastify } from "@/app/api/types";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

type OrganizationAccount = Readonly<{ accountId: string; sessionId: string }>;

function createStandingRouteBuilder() {
    return createRouteTestBuilder({
        method: "PUT",
        path: "/v2/session-organization/attention-standings/:sessionId",
        registerRoutes(app) {
            registerSessionOrganizationRoutes(app as unknown as Fastify);
        },
    });
}

function createSnapshotRouteBuilder() {
    return createRouteTestBuilder({
        method: "GET",
        path: "/v2/session-organization",
        registerRoutes(app) {
            registerSessionOrganizationRoutes(app as unknown as Fastify);
        },
    });
}

async function createAccountWithSession(): Promise<OrganizationAccount> {
    const account = await db.account.create({
        data: { publicKey: `pk-${randomUUID()}` },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tag: `session-${randomUUID()}`,
            metadata: "{}",
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
        },
        select: { id: true },
    });
    return { accountId: account.id, sessionId: session.id };
}

describe("session attention standings on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-attention-standing-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("round-trips the standing tri-state through the route", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const route = createStandingRouteBuilder();

        const kept = await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: true } });
        expect(kept.reply.statusCode).toBe(200);
        expect(kept.response).toEqual({
            standing: { sessionId, standing: true, updatedAt: expect.any(Number) },
        });

        const removed = await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: false } });
        expect(removed.reply.statusCode).toBe(200);
        expect(removed.response).toEqual({
            standing: { sessionId, standing: false, updatedAt: expect.any(Number) },
        });
        await expect(
            db.sessionAttentionStanding.findMany({
                where: { accountId },
                select: { sessionId: true, standing: true },
            }),
        ).resolves.toEqual([{ sessionId, standing: false }]);

        const cleared = await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: null } });
        expect(cleared.reply.statusCode).toBe(200);
        expect(cleared.response).toEqual({ standing: null });
        await expect(
            db.sessionAttentionStanding.count({ where: { accountId } }),
        ).resolves.toBe(0);
    });

    it("returns standings in the snapshot only when the include flag is requested", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        await createStandingRouteBuilder().invoke({
            userId: accountId,
            params: { sessionId },
            body: { standing: true },
        });
        const snapshotRoute = createSnapshotRouteBuilder();

        const withoutFlag = SessionOrganizationSnapshotResponseSchema.parse(
            (await snapshotRoute.invoke({ userId: accountId })).response,
        );
        expect(withoutFlag.snapshot.attentionStandings).toBeUndefined();

        const withFlag = SessionOrganizationSnapshotResponseSchema.parse(
            (await snapshotRoute.invoke({
                userId: accountId,
                query: { includeAttentionStandings: "true" },
            })).response,
        );
        expect(withFlag.snapshot.attentionStandings).toEqual([
            { sessionId, standing: true, updatedAt: expect.any(Number) },
        ]);
    });

    it("marks the attentionStandings scope and bumps the organization checkpoint", async () => {
        const { accountId, sessionId } = await createAccountWithSession();

        await createStandingRouteBuilder().invoke({
            userId: accountId,
            params: { sessionId },
            body: { standing: true },
        });

        await expect(
            db.sessionOrganizationCheckpoint.findUnique({
                where: { accountId },
                select: { version: true },
            }),
        ).resolves.toEqual({ version: 1 });
        await expect(
            db.accountChange.findFirst({
                where: { accountId, entityId: "session-organization" },
                select: { hint: true },
            }),
        ).resolves.toEqual({
            hint: { sessionOrganization: true, scope: "attentionStandings", sessionIds: [sessionId] },
        });
    });

    it("clears a standing for an archived session but refuses to set one", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const route = createStandingRouteBuilder();
        await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: true } });
        await db.session.update({ where: { id: sessionId }, data: { archivedAt: new Date() } });

        const rejected = await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: false } });
        expect(rejected.reply.statusCode).toBe(404);
        expect(rejected.response).toEqual({ error: "Session not found" });

        const cleared = await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: null } });
        expect(cleared.reply.statusCode).toBe(200);
        expect(cleared.response).toEqual({ standing: null });
        await expect(
            db.sessionAttentionStanding.count({ where: { accountId } }),
        ).resolves.toBe(0);
    });
});
