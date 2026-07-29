import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

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
        await db.session.create({
            data: {
                tag: "hidden-voice-read-result-candidate",
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({
                    path: "/repo/hidden-voice-read-result",
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
                latestReadyEventSeq: 3,
                latestReadyEventAt: new Date(1_500),
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
});
