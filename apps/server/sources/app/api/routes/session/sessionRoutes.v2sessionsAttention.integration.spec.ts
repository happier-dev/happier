import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";
import { createV2SessionAttentionPage } from "@/app/session/listing/initialPage";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import {
    computeAccountActivityBadgeCounts,
    computeAuthenticatedAccountActivityBadgeCount,
} from "@/app/activity/accountActivityBadge";
import { listSessionsForAccount } from "@/app/session/listing/service";
import { createV2SessionListServerTiming } from "@/app/session/listing/timing";

const authentication = createPresentUserSessionAccessAuthentication();

type TrackedOwnerSessionInput = Prisma.SessionUncheckedCreateInput & Readonly<{
    lastViewedSessionSeq?: number | null;
}>;

type AttentionSessionInput = Omit<
    TrackedOwnerSessionInput,
    "accountId" | "encryptionMode" | "metadata"
>;

async function createTrackedOwnerSession(args: Readonly<{
    data: TrackedOwnerSessionInput;
    select?: { id: true };
}>) {
    const { lastViewedSessionSeq, ...sessionData } = args.data;
    const session = await db.session.create({
        data: sessionData,
        select: { id: true },
    });
    await db.accountSessionReadState.create({
        data: {
            accountId: args.data.accountId,
            sessionId: session.id,
            lastViewedSessionSeq: typeof lastViewedSessionSeq === "number"
                ? lastViewedSessionSeq
                : 0,
            unreadSince: null,
        },
    });
    return session;
}

async function createSparseOwnerAttentionCandidates(params: Readonly<{
    accountId: string;
    rejectedCount: number;
    exactMatchCount: number;
}>) {
    const rejected = Array.from({ length: params.rejectedCount }, (_, index) => ({
        id: randomUUID(),
        accountId: params.accountId,
        tag: randomUUID(),
        encryptionMode: "plain" as const,
        metadata: "{}",
        meaningfulActivityAt: new Date(10_000 + index),
        latestTurnStatus: "failed",
        // Relational candidacy is intentionally broader than exact attention:
        // only a canonical primary-session runtime issue is admitted.
        lastRuntimeIssue: "not-a-canonical-runtime-issue",
    }));
    const matches = Array.from({ length: params.exactMatchCount }, (_, index) => ({
        id: randomUUID(),
        accountId: params.accountId,
        tag: randomUUID(),
        encryptionMode: "plain" as const,
        metadata: "{}",
        meaningfulActivityAt: new Date(1_000 - index),
        pendingBlockedCount: 1,
    }));
    await db.session.createMany({ data: [...rejected, ...matches] });
    return {
        matchIds: matches.map((session) => session.id),
    };
}

describe("sessionRoutes initial durable-attention hydration (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-attention-hydration-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) {
            await harness.close();
        }
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv({
            HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: "2",
        });
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("strict query scans past 200 in-base relational false positives before limiting exact attention", async () => {
        harness.resetEnv({ HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: "200" });
        const owner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const sparse = await createSparseOwnerAttentionCandidates({
            accountId: owner.id,
            rejectedCount: 205,
            exactMatchCount: 2,
        });

        const query = {
            v: 1 as const,
            storage: "active" as const,
            includeInactive: true,
            scope: "my_work" as const,
            attention: "needs_my_attention" as const,
            audiences: { include: [], exclude: [] },
            tagIds: { include: [], exclude: [] },
            limit: 1,
        };
        const read = async (cursor?: string) => await listSessionsForAccount({
            userId: owner.id,
            authentication,
            source: { kind: "query", query: { ...query, ...(cursor ? { cursor } : {}) } },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        });
        const first = await read();
        expect(first).toMatchObject({
            sessions: [{ id: sparse.matchIds[0] }],
            hasNext: true,
            nextCursor: expect.any(String),
            attentionHasNext: false,
            attentionNextCursor: null,
        });
        const firstCursor = first && "nextCursor" in first ? first.nextCursor : null;
        expect(await read(firstCursor ?? undefined)).toMatchObject({
            sessions: [{ id: sparse.matchIds[1] }],
            hasNext: false,
            nextCursor: null,
            attentionHasNext: false,
            attentionNextCursor: null,
        });
    });

    it("released GET preserves supplemental continuation after 200 rejected attention candidates", async () => {
        harness.resetEnv({ HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: "200" });
        const owner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const sparse = await createSparseOwnerAttentionCandidates({
            accountId: owner.id,
            rejectedCount: 205,
            exactMatchCount: 1,
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const first = await app.inject({
                    method: "GET",
                    url: "/v2/sessions?includeAttention=true&limit=1",
                    headers: { "x-test-user-id": owner.id },
                });
                expect(first.statusCode).toBe(200);
                const firstBody = first.json();
                expect(firstBody.sessions.map((session: { id: string }) => session.id))
                    .not.toContain(sparse.matchIds[0]);
                expect(firstBody).toMatchObject({
                    attentionHasNext: true,
                    attentionNextCursor: expect.any(String),
                });

                const continued = await app.inject({
                    method: "GET",
                    url: `/v2/sessions?attentionCursor=${encodeURIComponent(firstBody.attentionNextCursor)}&limit=1`,
                    headers: { "x-test-user-id": owner.id },
                });
                expect(continued.statusCode).toBe(200);
                expect(continued.json()).toMatchObject({
                    sessions: [{ id: sparse.matchIds[0] }],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: null,
                    attentionHasNext: false,
                });
            },
        );
    });

    it("counts sparse exact badge attention beyond 450 content-free candidates", async () => {
        const owner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        await createSparseOwnerAttentionCandidates({
            accountId: owner.id,
            rejectedCount: 450,
            exactMatchCount: 2,
        });
        // Both count entry points are structural. Deliberately non-decodable
        // content must not be loaded or interpreted to produce the exact count.
        await db.session.updateMany({
            where: { accountId: owner.id },
            data: { metadata: "content-is-not-part-of-badge-candidacy" },
        });

        expect((await computeAccountActivityBadgeCounts([owner.id])).get(owner.id)).toBe(2);
        expect(await computeAuthenticatedAccountActivityBadgeCount(owner.id, authentication)).toBe(2);
    });

    it("measures exact attention count and refill over quiet tracked SQLite corpora", async () => {
        for (const quietCount of [200, 2_000]) {
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const quiet = Array.from({ length: quietCount }, (_, index) => ({
                id: randomUUID(), accountId: owner.id, tag: randomUUID(), encryptionMode: "plain" as const,
                metadata: "{}", seq: 1, meaningfulActivityAt: new Date(10_000 + index),
            }));
            await db.session.createMany({ data: quiet });
            await db.accountSessionReadState.createMany({ data: quiet.map(row => ({
                sessionId: row.id, accountId: owner.id, lastViewedSessionSeq: 1,
            })) });
            const sparse = await createSparseOwnerAttentionCandidates({ accountId: owner.id, rejectedCount: 0, exactMatchCount: 2 });
            const samples: Array<{ countMs: number; firstPageMs: number; nextPageMs: number }> = [];
            for (let sample = 0; sample < 3; sample += 1) {
                const started = performance.now();
                expect(await computeAuthenticatedAccountActivityBadgeCount(owner.id, authentication)).toBe(2);
                const counted = performance.now();
                const read = (cursor?: string) => listSessionsForAccount({
                    userId: owner.id, authentication,
                    source: { kind: "query", query: {
                        v: 1, storage: "active", includeInactive: true, scope: "my_work",
                        attention: "needs_my_attention", audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, limit: 1,
                        ...(cursor ? { cursor } : {}),
                    } },
                    rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}),
                });
                const first = await read();
                const firstRead = performance.now();
                expect(first).toMatchObject({ sessions: [{ id: sparse.matchIds[0] }], hasNext: true });
                const cursor = first && "nextCursor" in first ? first.nextCursor : null;
                expect(cursor).toBeTypeOf("string");
                expect(await read(cursor ?? undefined)).toMatchObject({
                    sessions: [{ id: sparse.matchIds[1] }], hasNext: false,
                });
                const finished = performance.now();
                samples.push({ countMs: counted - started, firstPageMs: firstRead - counted, nextPageMs: finished - firstRead });
            }
            // Measurement evidence only: no guessed wall-clock budget becomes a product/test limit.
            console.info("personal-attention-sqlite-measurement", JSON.stringify({ quietCount, exactMatches: 2, samples }));
        }
    });

    it("filters non-attention rows before the candidate window", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-attention-hydration-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await createTrackedOwnerSession({
            data: {
                tag: "ordinary-first-page",
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ path: "/repo/ordinary", host: "test-host" }),
                agentState: JSON.stringify({}),
                seq: 1,
                lastViewedSessionSeq: 1,
                meaningfulActivityAt: new Date(3_000),
            },
        });
        const lateResult = await createTrackedOwnerSession({
            data: {
                tag: "hidden-voice-late-result",
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({
                    path: "/repo/hidden-voice-result",
                    host: "test-host",
                    systemSessionV1: {
                        v: 1,
                        key: "voice_conversation_retired",
                        hidden: true,
                    },
                }),
                agentState: JSON.stringify({}),
                seq: 4,
                lastViewedSessionSeq: 2,
                latestReadyEventSeq: 4,
                latestReadyEventAt: new Date(2_000),
                meaningfulActivityAt: new Date(2_000),
            },
            select: { id: true },
        });
        // A failed turn without the canonical runtime issue is quiet and must be
        // removed by the exact personal-attention predicate before pagination.
        await createTrackedOwnerSession({
            data: {
                tag: "hidden-voice-failed-turn-without-runtime-issue",
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({
                    path: "/repo/hidden-voice-failed-turn",
                    host: "test-host",
                    systemSessionV1: {
                        v: 1,
                        key: "voice_conversation_retired",
                        hidden: true,
                    },
                }),
                agentState: JSON.stringify({}),
                seq: 3,
                lastViewedSessionSeq: 3,
                latestTurnStatus: "failed",
                active: false,
                meaningfulActivityAt: new Date(1_500),
            },
        });
        const permissionRequest = {
            tool: "Bash",
            kind: "permission",
            arguments: { command: "git status" },
            createdAt: 1_000,
        };
        const pendingPermission = await createTrackedOwnerSession({
            data: {
                tag: "hidden-voice-pending-permission",
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({
                    path: "/repo/hidden-voice-permission",
                    host: "test-host",
                    systemSessionV1: {
                        v: 1,
                        key: "voice_conversation_retired",
                        hidden: true,
                    },
                }),
                agentState: JSON.stringify({
                    requests: {
                        approve: permissionRequest,
                    },
                }),
                agentStateVersion: 1,
                seq: 2,
                lastViewedSessionSeq: 2,
                pendingPermissionRequestCount: 1,
                pendingRequestObservedAt: new Date(1_000),
                meaningfulActivityAt: new Date(1_000),
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: "/v2/sessions?includeAttention=true&limit=1",
                    headers: {
                        "x-test-user-id": owner.id,
                    },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json();
                const attentionPages = [body];
                const seenCursors = new Set<string>();
                let attentionCursor = body.attentionNextCursor as string | null;
                while (attentionCursor) {
                    expect(seenCursors.has(attentionCursor)).toBe(false);
                    seenCursors.add(attentionCursor);
                    const continuation = await app.inject({
                        method: "GET",
                        url: `/v2/sessions?attentionCursor=${encodeURIComponent(attentionCursor)}&limit=1`,
                        headers: { "x-test-user-id": owner.id },
                    });
                    expect(continuation.statusCode).toBe(200);
                    const continuationBody = continuation.json();
                    attentionPages.push(continuationBody);
                    attentionCursor = continuationBody.attentionNextCursor;
                }
                const hydratedSessions = attentionPages.flatMap(
                    (page) => page.sessions as Array<{
                        id: string;
                        encryptionMode: string;
                        pendingPermissionRequestCount: number;
                        agentStateVersion: number;
                        agentState: string;
                    }>,
                );
                expect(hydratedSessions.map((session) => session.id)).toEqual(
                    expect.arrayContaining([lateResult.id, pendingPermission.id]),
                );
                expect(attentionPages.at(-1)).toMatchObject({
                    attentionHasNext: false,
                    attentionNextCursor: null,
                });
                const hydratedPermission = hydratedSessions.find(
                    (session: { id: string }) => session.id === pendingPermission.id,
                );
                if (!hydratedPermission) {
                    throw new Error("Expected the pending-permission Session to be hydrated");
                }
                expect(hydratedPermission).toMatchObject({
                    encryptionMode: "plain",
                    pendingPermissionRequestCount: 1,
                    agentStateVersion: 1,
                });
                expect(JSON.parse(hydratedPermission.agentState)).toEqual({
                    requests: {
                        approve: permissionRequest,
                    },
                });
            },
        );
    });

    it("KEYSTONE keeps surfacing sessions without meaningful activity past the first attention page", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-attention-null-activity-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const createAttentionSession = async (
            data: AttentionSessionInput,
        ) => await createTrackedOwnerSession({
            data: {
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ path: "/repo/attention", host: "test-host" }),
                agentState: JSON.stringify({}),
                ...data,
            },
            select: { id: true },
        });

        await createAttentionSession({
            tag: "attention-page-1-unread-result",
            seq: 5,
            lastViewedSessionSeq: 1,
            latestReadyEventSeq: 5,
            latestReadyEventAt: new Date(5_000),
            meaningfulActivityAt: new Date(5_000),
        });
        await createAttentionSession({
            tag: "attention-page-1-permission",
            seq: 4,
            lastViewedSessionSeq: 4,
            pendingPermissionRequestCount: 1,
            meaningfulActivityAt: new Date(4_000),
        });
        // No meaningful activity yet, so this row is ordered by `createdAt` through the
        // created-at fallback branch of the effective-activity read.
        const neverActive = await createAttentionSession({
            tag: "attention-page-2-never-active-permission",
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingPermissionRequestCount: 1,
            meaningfulActivityAt: null,
            createdAt: new Date(3_000),
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: "/v2/sessions?includeAttention=true&limit=1",
                    headers: { "x-test-user-id": owner.id },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.attentionHasNext).toBe(true);
                expect(body.attentionNextCursor).toEqual(expect.any(String));

                const continuation = await app.inject({
                    method: "GET",
                    url: `/v2/sessions?attentionCursor=${encodeURIComponent(body.attentionNextCursor)}&limit=1`,
                    headers: { "x-test-user-id": owner.id },
                });

                expect(continuation.statusCode).toBe(200);
                const continuationBody = continuation.json();
                expect(continuationBody.sessions.map((session: { id: string }) => session.id)).toEqual([
                    neverActive.id,
                ]);
            },
        );
    });

    it("KEYSTONE does not spend candidate slots on sessions whose ready event was already read", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-attention-read-ready-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const createAttentionSession = async (
            data: AttentionSessionInput,
        ) => await createTrackedOwnerSession({
            data: {
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ path: "/repo/read-ready", host: "test-host" }),
                agentState: JSON.stringify({}),
                ...data,
            },
            select: { id: true },
        });

        // Both were ready once and have since been read. The exact personal-attention
        // predicate must remove them before the candidate window is applied.
        const newestRead = await createAttentionSession({
            tag: "read-ready-newest",
            seq: 3,
            lastViewedSessionSeq: 3,
            latestReadyEventSeq: 3,
            latestReadyEventAt: new Date(3_000),
            meaningfulActivityAt: new Date(3_000),
        });
        await createAttentionSession({
            tag: "read-ready-older",
            seq: 5,
            lastViewedSessionSeq: 7,
            latestReadyEventSeq: 5,
            latestReadyEventAt: new Date(2_500),
            meaningfulActivityAt: new Date(2_500),
        });
        const durablePermission = await createAttentionSession({
            tag: "durable-permission-behind-read-candidates",
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingPermissionRequestCount: 1,
            meaningfulActivityAt: new Date(2_000),
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: "/v2/sessions?includeAttention=true&limit=1",
                    headers: { "x-test-user-id": owner.id },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json();
                const ids = body.sessions.map((session: { id: string }) => session.id);
                expect(ids).toContain(durablePermission.id);
                // The ordinary first page still carries the newest session; only the attention
                // hydration is at stake here.
                expect(ids).toContain(newestRead.id);
                expect(body).toMatchObject({
                    attentionHasNext: false,
                    attentionNextCursor: null,
                });
            },
        );
    });

    it("KEYSTONE keeps every confirmed durable-attention row inside the candidate window", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-attention-superset-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const createAttentionSession = async (
            data: AttentionSessionInput,
        ) => await createTrackedOwnerSession({
            data: {
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ path: "/repo/superset", host: "test-host" }),
                agentState: JSON.stringify({}),
                ...data,
            },
            select: { id: true },
        });

        const readyAfterViewed = await createAttentionSession({
            tag: "ready-after-viewed",
            seq: 2,
            lastViewedSessionSeq: 1,
            latestReadyEventSeq: 2,
            latestReadyEventAt: new Date(7_000),
            meaningfulActivityAt: new Date(7_000),
        });
        // The legacy-null owner cursor is migrated into the canonical viewer row at
        // zero, so ready sequence one remains unread through the relational predicate.
        const readyNeverViewed = await createAttentionSession({
            tag: "ready-never-viewed",
            seq: 1,
            lastViewedSessionSeq: null,
            latestReadyEventSeq: 1,
            latestReadyEventAt: new Date(6_000),
            meaningfulActivityAt: new Date(6_000),
        });
        await createAttentionSession({
            tag: "ready-equal-to-viewed",
            seq: 3,
            lastViewedSessionSeq: 3,
            latestReadyEventSeq: 3,
            latestReadyEventAt: new Date(5_000),
            meaningfulActivityAt: new Date(5_000),
        });
        await createAttentionSession({
            tag: "ready-below-viewed",
            seq: 5,
            lastViewedSessionSeq: 5,
            latestReadyEventSeq: 2,
            latestReadyEventAt: new Date(4_000),
            meaningfulActivityAt: new Date(4_000),
        });
        // A zero ready sequence is not an unread ready event, but visible sequence one
        // is still above the canonical viewer cursor and qualifies through unread.
        const readyZeroNeverViewed = await createAttentionSession({
            tag: "ready-zero-never-viewed",
            seq: 1,
            lastViewedSessionSeq: null,
            latestReadyEventSeq: 0,
            latestReadyEventAt: new Date(3_500),
            meaningfulActivityAt: new Date(3_500),
        });
        const pendingPermission = await createAttentionSession({
            tag: "superset-pending-permission",
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingPermissionRequestCount: 1,
            meaningfulActivityAt: new Date(3_000),
        });
        const pendingUserAction = await createAttentionSession({
            tag: "superset-pending-user-action",
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingUserActionRequestCount: 1,
            meaningfulActivityAt: new Date(2_000),
        });
        await createAttentionSession({
            tag: "superset-quiet-and-read",
            seq: 1,
            lastViewedSessionSeq: 1,
            meaningfulActivityAt: new Date(1_000),
        });

        const page = await createV2SessionAttentionPage({
            where: { archivedAt: null },
            userId: owner.id,
            candidateLimit: 50,
            authentication,
        });

        expect(page.rows.map((row) => row.id)).toEqual([
            readyAfterViewed.id,
            readyNeverViewed.id,
            readyZeroNeverViewed.id,
            pendingPermission.id,
            pendingUserAction.id,
        ]);
    });

    it("KEYSTONE hydrates unread session activity whose ready event is already behind the read cursor", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-attention-unread-activity-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const createAttentionSession = async (
            data: AttentionSessionInput,
        ) => await createTrackedOwnerSession({
            data: {
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ path: "/repo/unread-activity", host: "test-host" }),
                agentState: JSON.stringify({}),
                ...data,
            },
            select: { id: true },
        });

        // Provider activity landed after the reader caught up with the last ready event, so the
        // ready-event cursor alone cannot see it.
        const unreadAfterReadReadyEvent = await createAttentionSession({
            tag: "unread-after-read-ready-event",
            seq: 7,
            lastViewedSessionSeq: 3,
            latestReadyEventSeq: 2,
            latestReadyEventAt: new Date(1_000),
            meaningfulActivityAt: new Date(6_000),
        });
        const unreadNeverViewed = await createAttentionSession({
            tag: "unread-never-viewed-without-ready-event",
            seq: 1,
            lastViewedSessionSeq: null,
            meaningfulActivityAt: new Date(5_000),
        });
        await createAttentionSession({
            tag: "read-and-quiet",
            seq: 4,
            lastViewedSessionSeq: 4,
            meaningfulActivityAt: new Date(4_000),
        });

        const page = await createV2SessionAttentionPage({
            where: { archivedAt: null },
            userId: owner.id,
            candidateLimit: 50,
            authentication,
        });

        expect(page.rows.map((row) => row.id)).toEqual([
            unreadAfterReadReadyEvent.id,
            unreadNeverViewed.id,
        ]);
    });

    it("keeps above-ceiling finite candidates quiet across the bounded attention continuation", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-attention-publication-ceiling-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const hostedAttention = await createTrackedOwnerSession({
            data: {
                tag: "hosted-attention-keeps-cursor",
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ path: "/repo/hosted-attention", host: "test-host" }),
                agentState: JSON.stringify({}),
                pendingPermissionRequestCount: 1,
                meaningfulActivityAt: new Date(10_000),
            },
            select: { id: true },
        });
        const finiteSnapshot = await createTrackedOwnerSession({
            data: {
                tag: "finite-attention-private-catchup",
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ path: "/repo/finite-attention", host: "test-host" }),
                agentState: JSON.stringify({}),
                seq: 5,
                lastViewedSessionSeq: 1,
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 1,
                materializationPublicationId: "attention-publication-v1",
                materializedThroughSourceAt: 5_000n,
                publishedThroughServerSeq: 1,
                createdAt: new Date(4_000),
                meaningfulActivityAt: new Date(20_000),
            },
            select: { id: true },
        });

        const beforePrivateCatchup = await createV2SessionAttentionPage({
            where: { archivedAt: null },
            userId: owner.id,
            candidateLimit: 1,
            authentication,
        });
        expect(beforePrivateCatchup).toMatchObject({
            rows: [{ id: hostedAttention.id }],
            attentionNextCursor: null,
            attentionHasNext: false,
        });

        await db.session.update({
            where: { id: finiteSnapshot.id },
            data: {
                pendingPermissionRequestCount: 1,
                latestReadyEventSeq: 5,
                latestReadyEventAt: new Date(20_000),
            },
        });

        const afterPrivateCatchup = await createV2SessionAttentionPage({
            where: { archivedAt: null },
            userId: owner.id,
            candidateLimit: 1,
            authentication,
        });
        expect(afterPrivateCatchup.rows.map((row) => row.id)).toEqual(
            beforePrivateCatchup.rows.map((row) => row.id),
        );
        expect(afterPrivateCatchup.attentionNextCursor).toBe(
            beforePrivateCatchup.attentionNextCursor,
        );
        expect(afterPrivateCatchup.attentionHasNext).toBe(
            beforePrivateCatchup.attentionHasNext,
        );
    });
});
