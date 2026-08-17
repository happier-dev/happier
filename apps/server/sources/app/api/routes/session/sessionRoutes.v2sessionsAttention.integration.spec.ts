import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";
import { createV2SessionAttentionPage } from "./v2SessionListInitialPage";

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

    it("continues past a filtered newer result candidate to surface an older hidden permission", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-attention-hydration-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.session.create({
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
        const lateResult = await db.session.create({
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
        // Candidate through the failed-turn arm, which the predicate cannot narrow further: the
        // stored runtime issue is what decides, and it is absent here, so `isDurableAttentionRow`
        // rejects the row after it has already spent a candidate slot.
        await db.session.create({
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
        const pendingPermission = await db.session.create({
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
                expect(body.sessions.map((session: { id: string }) => session.id)).toContain(lateResult.id);
                expect(body.sessions.map((session: { id: string }) => session.id)).not.toContain(pendingPermission.id);
                expect(body.attentionHasNext).toBe(true);
                expect(body.attentionNextCursor).toEqual(expect.any(String));

                const continuation = await app.inject({
                    method: "GET",
                    url: `/v2/sessions?attentionCursor=${encodeURIComponent(body.attentionNextCursor)}&limit=1`,
                    headers: {
                        "x-test-user-id": owner.id,
                    },
                });

                expect(continuation.statusCode).toBe(200);
                const continuationBody = continuation.json();
                expect(continuationBody.sessions.map((session: { id: string }) => session.id)).toEqual([
                    pendingPermission.id,
                ]);
                expect(continuationBody.attentionNextCursor).toBeNull();
                expect(continuationBody.attentionHasNext).toBe(false);
                const hydratedPermission = continuationBody.sessions.find(
                    (session: { id: string }) => session.id === pendingPermission.id,
                );
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
            data: Omit<Prisma.SessionUncheckedCreateInput, "accountId" | "encryptionMode" | "metadata">,
        ) => await db.session.create({
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
            data: Omit<Prisma.SessionUncheckedCreateInput, "accountId" | "encryptionMode" | "metadata">,
        ) => await db.session.create({
            data: {
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ path: "/repo/read-ready", host: "test-host" }),
                agentState: JSON.stringify({}),
                ...data,
            },
            select: { id: true },
        });

        // Both of these were ready once and have since been read, so `isDurableAttentionRow`
        // rejects them. With the candidate limit at 2 they fill the whole window.
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
            data: Omit<Prisma.SessionUncheckedCreateInput, "accountId" | "encryptionMode" | "metadata">,
        ) => await db.session.create({
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
        // `hasUnreadReadyEvent` reads a missing `lastViewedSessionSeq` as 0, so this row is durable
        // even though SQL's `latestReadyEventSeq > lastViewedSessionSeq` is NULL for it.
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
        await createAttentionSession({
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
            userId: owner.id,
            candidateLimit: 50,
        });

        expect(page.rows.map((row) => row.id)).toEqual([
            readyAfterViewed.id,
            readyNeverViewed.id,
            pendingPermission.id,
            pendingUserAction.id,
        ]);
    });

    it("does not let above-ceiling finite attention facts consume the hosted attention cursor", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-attention-publication-ceiling-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const hostedAttention = await db.session.create({
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
        const finiteSnapshot = await db.session.create({
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
            userId: owner.id,
            candidateLimit: 1,
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
            userId: owner.id,
            candidateLimit: 1,
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
