import { randomUUID } from "node:crypto";

import { SessionOrganizationSnapshotResponseSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { decodeBase64 } from "privacy-kit";
import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/mini";

import { registerSessionOrganizationRoutes } from "@/app/api/routes/session/registerSessionOrganizationRoutes";
import { createRouteTestBuilder } from "@/app/api/testkit/routeTestBuilder";
import type { Fastify } from "@/app/api/types";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { setSessionAttentionStandingInTx } from "./organizationMutations";

type OrganizationAccount = Readonly<{ accountId: string; sessionId: string }>;
const deliveredMessages: ExpoPushMessage[] = [];

async function createBadgePushToken(accountId: string): Promise<string> {
    const token = `ExponentPushToken[${accountId}]`;
    await db.accountPushToken.create({ data: { accountId, token } });
    return token;
}

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

async function createSession(accountId: string): Promise<string> {
    const session = await db.session.create({
        data: {
            accountId,
            tag: `session-${randomUUID()}`,
            metadata: "{}",
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
        },
        select: { id: true },
    });
    await db.accountSessionReadState.create({
        data: { accountId, sessionId: session.id, lastViewedSessionSeq: 0, unreadSince: null },
    });
    return session.id;
}

async function createAccountWithSession(): Promise<OrganizationAccount> {
    const account = await db.account.create({
        data: { publicKey: `pk-${randomUUID()}` },
        select: { id: true },
    });
    return { accountId: account.id, sessionId: await createSession(account.id) };
}

describe("session attention standings on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        // Only Expo's network send is replaced. Recipient selection, badge
        // counting, timer coalescing and the real SQLite transaction stay real.
        vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(async (messages) => {
            deliveredMessages.push(...messages);
            return messages.map(() => ({ status: "ok" as const, id: randomUUID() }));
        });
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-attention-standing-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    beforeEach(() => {
        harness.resetEnv();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(async () => {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
    });

    afterAll(async () => {
        await harness.close();
        vi.restoreAllMocks();
    });

    it("requires an update only for released readers whose standing snapshot exceeds 500 rows", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const sessionIds = Array.from({ length: 500 }, () => randomUUID());
        await db.session.createMany({ data: sessionIds.map((id) => ({
            id, accountId, tag: `session-${id}`, metadata: "{}", metadataVersion: 0,
            agentState: null, agentStateVersion: 0,
        })) });
        await db.sessionAttentionStanding.createMany({ data: sessionIds.map((id) => ({
            accountId, sessionId: id, standing: true,
        })) });
        const route = createSnapshotRouteBuilder();
        const legacyQuery = { includeAttentionStandings: "true" };
        const withinLimit = await route.invoke({ userId: accountId, query: legacyQuery });
        expect(withinLimit.reply.statusCode).toBe(200);
        // Pinned ui-web-v0.2.11 (98ea8fb76733b1dd785d38c31360179cafa84824):
        // packages/protocol/src/sessionOrganization/{standings,snapshot,constants}.ts.
        // Keep this released strict vector independent of the current unrestricted schema.
        const releasedStandings = z.array(z.strictObject({
            sessionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(191)),
            standing: z.boolean(), updatedAt: z.number().check(z.int(), z.nonnegative()),
        })).check(z.maxLength(500));
        const withinSnapshot = SessionOrganizationSnapshotResponseSchema.parse(withinLimit.response).snapshot;
        expect(releasedStandings.parse(withinSnapshot.attentionStandings)).toHaveLength(500);

        const write = await createStandingRouteBuilder().invoke({
            userId: accountId, params: { sessionId }, body: { standing: true },
        });
        expect(write.reply.statusCode).toBe(200);
        const oversized = await route.invoke({ userId: accountId, query: legacyQuery });
        expect(oversized.reply.statusCode).toBe(426);
        expect(oversized.response).toEqual({
            error: "client-upgrade-required",
            requirement: { v: 1, kind: "session-organization", minimumProtocolVersion: 2 },
        });
        const current = await route.invoke({
            userId: accountId, query: { ...legacyQuery, projectionVersion: "2" },
        });
        expect(current.reply.statusCode).toBe(200);
        expect(SessionOrganizationSnapshotResponseSchema.parse(current.response).snapshot.attentionStandings)
            .toHaveLength(501);
        expect((await route.invoke({ userId: accountId, query: {} })).reply.statusCode).toBe(200);
    });

    it("round-trips the standing tri-state through the route", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const route = createStandingRouteBuilder();

        const kept = await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: true } });
        expect(kept.reply.statusCode).toBe(200);
        expect(kept.response).toEqual({
            standing: { sessionId, standing: true, updatedAt: expect.any(Number) },
        });

        // An explicit "remove from Needs attention" is a stored false, not a deleted row: it has to
        // survive an account default of true.
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

    it("sets a reminder for an unfollowed reader with an inert retained cursor without re-enrolling tracking", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const reader = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const sessionId = await createSession(owner.id);
        await db.sessionGrant.create({
            data: { principalKind: 'account',
                sessionId,
                createdByAccountId: owner.id,
                accountId: reader.id,
                accessLevel: "view",
            },
        });
        await db.accountSessionReadState.create({
            data: {
                accountId: reader.id,
                sessionId,
                lastViewedSessionSeq: 0,
                unreadSince: new Date(1_000),
            },
        });

        const remindAt = Date.now() + 60_000;
        const response = await createStandingRouteBuilder().invoke({
            userId: reader.id,
            params: { sessionId },
            body: { remindAt },
        });

        expect(response.reply.statusCode).toBe(200);
        expect(response.response).toEqual({
            standing: { sessionId, standing: false, remindAt, updatedAt: expect.any(Number) },
        });
        await expect(db.accountSessionReadState.findUnique({
            where: { accountId_sessionId: { accountId: reader.id, sessionId } },
            select: { lastViewedSessionSeq: true, unreadSince: true },
        })).resolves.toEqual({ lastViewedSessionSeq: 0, unreadSince: new Date(1_000) });
        await expect(db.accountSessionFollow.count({ where: { accountId: reader.id, sessionId } })).resolves.toBe(0);
    });

    it("preserves independent Discussion frontiers when scheduling a Session reminder", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const discussion = await db.discussion.create({
            data: {
                ownerAccountId: accountId, encryptionMode: "plain", dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
                anchorSessionId: sessionId, anchorV1: { kind: "session", sessionId },
                creationLocalId: randomUUID(),
                creationEqualityEvidenceV1: { kind: "plainDigest", digest: randomUUID() },
                createdByAccountId: accountId,
                titleContent: { t: "plain", v: { v: 1, title: "Reminder baseline" } },
                messageSeq: 4,
                lastMessageAt: new Date(),
                readStates: { create: { accountId, lastReadSeq: 1 } },
            },
        });

        const remindAt = Date.now() + 60_000;
        const response = await createStandingRouteBuilder().invoke({
            userId: accountId,
            params: { sessionId },
            body: { remindAt },
        });

        expect(response.reply.statusCode).toBe(200);
        await expect(db.discussionReadState.findUnique({
            where: { discussionId_accountId: { discussionId: discussion.id, accountId } },
            select: { lastReadSeq: true },
        })).resolves.toEqual({ lastReadSeq: 1 });
    });

    it("does not commit a reminder when the tracked owner's read lifecycle row is missing", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        await db.accountSessionReadState.delete({
            where: { accountId_sessionId: { accountId, sessionId } },
        });

        const response = await createStandingRouteBuilder().invoke({
            userId: accountId,
            params: { sessionId },
            body: { remindAt: Date.now() + 60_000 },
        });

        expect(response.reply.statusCode).toBe(404);
        await expect(db.sessionAttentionStanding.count({
            where: { accountId, sessionId },
        })).resolves.toBe(0);
        await expect(db.sessionOrganizationCheckpoint.count({ where: { accountId } })).resolves.toBe(0);
    });

    it("keeps a future reminder quiet for predecessor snapshots while current snapshots retain its deadline", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const remindAt = Date.now() + 60_000;
        await createStandingRouteBuilder().invoke({
            userId: accountId,
            params: { sessionId },
            body: { remindAt },
        });
        const snapshotRoute = createSnapshotRouteBuilder();

        const predecessor = SessionOrganizationSnapshotResponseSchema.parse((await snapshotRoute.invoke({
            userId: accountId,
            query: { includeAttentionStandings: "true" },
        })).response);
        expect(predecessor.snapshot.attentionStandings).toEqual([
            { sessionId, standing: false, updatedAt: expect.any(Number) },
        ]);

        const current = SessionOrganizationSnapshotResponseSchema.parse((await snapshotRoute.invoke({
            userId: accountId,
            query: {
                includeAttentionStandings: "true",
                includeAttentionReminderTimes: "true",
            },
        })).response);
        expect(current.snapshot.attentionStandings).toEqual([
            { sessionId, standing: false, remindAt, updatedAt: expect.any(Number) },
        ]);
    });

    it("restores the exact prior standing override when a reminder is removed", async () => {
        const route = createStandingRouteBuilder();
        const kept = await createAccountWithSession();
        const suppressed = await createAccountWithSession();
        const reminderOnly = await createAccountWithSession();
        const remindAt = Date.now() + 60_000;

        await route.invoke({ userId: kept.accountId, params: { sessionId: kept.sessionId }, body: { standing: true } });
        await route.invoke({ userId: kept.accountId, params: { sessionId: kept.sessionId }, body: { remindAt } });
        const restored = await route.invoke({
            userId: kept.accountId,
            params: { sessionId: kept.sessionId },
            body: { remindAt: null },
        });
        expect(restored.response).toEqual({
            standing: { sessionId: kept.sessionId, standing: true, updatedAt: expect.any(Number) },
        });
        await vi.runOnlyPendingTimersAsync();
        const repeatedRemoval = await route.invoke({
            userId: kept.accountId,
            params: { sessionId: kept.sessionId },
            body: { remindAt: null },
        });
        expect(repeatedRemoval.response).toEqual({
            standing: { sessionId: kept.sessionId, standing: true, updatedAt: expect.any(Number) },
        });
        // Removing an already-removed reminder changes nothing, so it owes no badge refresh.
        expect(vi.getTimerCount()).toBe(0);

        await route.invoke({ userId: suppressed.accountId, params: { sessionId: suppressed.sessionId }, body: { standing: false } });
        await route.invoke({ userId: suppressed.accountId, params: { sessionId: suppressed.sessionId }, body: { remindAt } });
        const restoredSuppression = await route.invoke({
            userId: suppressed.accountId,
            params: { sessionId: suppressed.sessionId },
            body: { remindAt: null },
        });
        expect(restoredSuppression.response).toEqual({
            standing: { sessionId: suppressed.sessionId, standing: false, updatedAt: expect.any(Number) },
        });

        await route.invoke({ userId: reminderOnly.accountId, params: { sessionId: reminderOnly.sessionId }, body: { remindAt } });
        const cleared = await route.invoke({
            userId: reminderOnly.accountId,
            params: { sessionId: reminderOnly.sessionId },
            body: { remindAt: null },
        });
        expect(cleared.response).toEqual({ standing: null });
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
        const token = await createBadgePushToken(accountId);
        const unrelated = await createAccountWithSession();
        const unrelatedToken = await createBadgePushToken(unrelated.accountId);

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
        await vi.runOnlyPendingTimersAsync();
        await vi.waitFor(() => {
            expect(deliveredMessages.filter((message) => message.to === token || message.to === unrelatedToken))
                .toEqual([{ to: token, badge: 1, data: { type: "badge_refresh" } }]);
        });
    });

    it("does not schedule a badge refresh when the enclosing transaction rolls back", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const token = await createBadgePushToken(accountId);

        await expect(inTx(async (tx) => {
            await setSessionAttentionStandingInTx(tx, {
                accountId,
                sessionId,
                request: { standing: true },
                authentication: {
                    env: process.env,
                    authority: "present_user",
                    authenticationEvidence: undefined,
                },
            });
            throw new Error("rolled back after the attention write");
        })).rejects.toThrow("rolled back after the attention write");

        await expect(db.sessionAttentionStanding.count({ where: { accountId } })).resolves.toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(deliveredMessages.filter((message) => message.to === token)).toEqual([]);
    });

    it("does not schedule a badge refresh for a standing write that changes nothing", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const token = await createBadgePushToken(accountId);
        const route = createStandingRouteBuilder();

        await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: true } });
        await vi.runOnlyPendingTimersAsync();
        await vi.waitFor(() => {
            expect(deliveredMessages.filter((message) => message.to === token))
                .toEqual([{ to: token, badge: 1, data: { type: "badge_refresh" } }]);
        });

        const repeated = await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: true } });
        expect(repeated.reply.statusCode).toBe(200);
        expect(repeated.response).toEqual({
            standing: { sessionId, standing: true, updatedAt: expect.any(Number) },
        });
        expect(vi.getTimerCount()).toBe(0);
        expect(deliveredMessages.filter((message) => message.to === token)).toHaveLength(1);
        await expect(
            db.sessionOrganizationCheckpoint.findUnique({ where: { accountId }, select: { version: true } }),
        ).resolves.toEqual({ version: 1 });
    });

    it("does not schedule a badge refresh when clearing a standing the account never declared", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const token = await createBadgePushToken(accountId);

        const cleared = await createStandingRouteBuilder().invoke({
            userId: accountId,
            params: { sessionId },
            body: { standing: null },
        });

        expect(cleared.reply.statusCode).toBe(200);
        expect(cleared.response).toEqual({ standing: null });
        expect(vi.getTimerCount()).toBe(0);
        expect(deliveredMessages.filter((message) => message.to === token)).toEqual([]);
        await expect(db.sessionOrganizationCheckpoint.count({ where: { accountId } })).resolves.toBe(0);
    });

    it("does not impose an arbitrary standing-row ceiling", async () => {
        const { accountId, sessionId } = await createAccountWithSession();
        const route = createStandingRouteBuilder();
        await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: true } });

        for (let index = 0; index < 500; index += 1) {
            await db.sessionAttentionStanding.create({
                data: { accountId, sessionId: await createSession(accountId), standing: true },
                select: { sessionId: true },
            });
        }

        const overflowSessionId = await createSession(accountId);
        const added = await route.invoke({
            userId: accountId,
            params: { sessionId: overflowSessionId },
            body: { standing: true },
        });
        expect(added.reply.statusCode).toBe(200);

        const flipped = await route.invoke({ userId: accountId, params: { sessionId }, body: { standing: false } });
        expect(flipped.reply.statusCode).toBe(200);
        expect(flipped.response).toEqual({
            standing: { sessionId, standing: false, updatedAt: expect.any(Number) },
        });
        await expect(
            db.sessionAttentionStanding.count({ where: { accountId } }),
        ).resolves.toBe(502);

        const snapshot = await createSnapshotRouteBuilder().invoke({
            userId: accountId,
            query: { includeAttentionStandings: "true", projectionVersion: "2" },
        });
        expect(SessionOrganizationSnapshotResponseSchema.parse(snapshot.response).snapshot.attentionStandings)
            .toHaveLength(502);
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
