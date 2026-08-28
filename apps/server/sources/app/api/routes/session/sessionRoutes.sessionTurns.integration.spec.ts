import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

describe("sessionRoutes session turns (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-session-turns-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionTurnMutationReceipt.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("accepts the initial begin mutation through the HTTP route", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-session-turn-begin",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: "session-turn-begin",
                accountId: account.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ t: "plain", v: {} }),
                agentState: null,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/turns/mutations`,
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        v: 1,
                        sessionId: session.id,
                        mutationId: "begin-1",
                        turnId: "turn-1",
                        action: "begin",
                        provider: "codex",
                        observedAt: 100,
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toMatchObject({
                    success: true,
                    applied: true,
                    receipt: {
                        v: 1,
                        sessionId: session.id,
                        mutationId: "begin-1",
                        turnId: "turn-1",
                        action: "begin",
                        decision: "applied",
                        observedAt: 100,
                    },
                });

                const projectionRes = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${session.id}/turns`,
                    headers: { "x-test-user-id": account.id },
                });

                expect(projectionRes.statusCode).toBe(200);
                expect(projectionRes.json()).toMatchObject({
                    v: 1,
                    sessionId: session.id,
                    latestTurnId: "turn-1",
                    turns: [
                        {
                            turnId: "turn-1",
                            agentId: "codex",
                            status: "in_progress",
                            startedAt: 100,
                            updatedAt: 100,
                            lastMutationId: "begin-1",
                        },
                    ],
                });
            },
        );

        await expect(db.session.findUnique({
            where: { id: session.id },
            select: {
                latestTurnId: true,
                latestTurnStatus: true,
                latestTurnStatusObservedAt: true,
                lastRuntimeIssue: true,
            },
        })).resolves.toEqual({
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: BigInt(100),
            lastRuntimeIssue: null,
        });
        await expect(db.sessionTurn.findUnique({
            where: { sessionId_turnId: { sessionId: session.id, turnId: "turn-1" } },
            select: {
                status: true,
                lastRuntimeIssueJson: true,
            },
        })).resolves.toEqual({
            status: "in_progress",
            lastRuntimeIssueJson: null,
        });
        await expect(db.sessionTurnMutationReceipt.findUnique({
            where: { sessionId_mutationId: { sessionId: session.id, mutationId: "begin-1" } },
            select: {
                action: true,
                decision: true,
                observedAt: true,
            },
        })).resolves.toEqual({
            action: "begin",
            decision: "applied",
            observedAt: BigInt(100),
        });
    });

    it("refuses a direct host turn mutation for a finite external snapshot before writing a receipt or projection", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-session-turn-finite-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: "session-turn-finite-owner",
                accountId: account.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ t: "plain", v: {} }),
                agentState: null,
                seq: 1,
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 1,
                materializationPublicationId: "finite-turn-owner-publication",
                materializedThroughSourceAt: 1_700_000_000_000n,
                publishedThroughServerSeq: 1,
            },
            select: { id: true },
        });

        await expect(applySessionTurnMutation({
            actorUserId: account.id,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: "finite-owner-begin",
                turnId: "finite-owner-turn",
                action: "begin",
                provider: "codex",
                observedAt: 100,
                transcriptAnchors: { endSeqInclusive: 1 },
            },
        })).resolves.toEqual({
            ok: false,
            error: "invalid-params",
            code: "session_storage_authority_mismatch",
        });

        await expect(db.sessionTurn.count({
            where: { sessionId: session.id },
        })).resolves.toBe(0);
        await expect(db.sessionTurnMutationReceipt.count({
            where: { sessionId: session.id },
        })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                latestTurnId: true,
                latestTurnStatus: true,
                latestTurnStatusObservedAt: true,
                lastRuntimeIssue: true,
            },
        })).resolves.toEqual({
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
        });
    });

    it("refuses a replayed host turn mutation after its session becomes a finite snapshot", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-session-turn-finite-replay",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: "session-turn-finite-replay",
                accountId: account.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ t: "plain", v: {} }),
                agentState: null,
            },
            select: { id: true },
        });
        const mutation = {
            v: 1 as const,
            sessionId: session.id,
            mutationId: "finite-replay-begin",
            turnId: "finite-replay-turn",
            action: "begin" as const,
            provider: "codex",
            observedAt: 100,
        };

        await expect(applySessionTurnMutation({
            actorUserId: account.id,
            mutation,
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await db.session.update({
            where: { id: session.id },
            data: {
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 0,
                materializationPublicationId: "finite-turn-replay-publication",
                materializedThroughSourceAt: 1_700_000_000_000n,
                publishedThroughServerSeq: 0,
            },
        });

        await expect(applySessionTurnMutation({
            actorUserId: account.id,
            mutation,
        })).resolves.toEqual({
            ok: false,
            error: "invalid-params",
            code: "session_storage_authority_mismatch",
        });
        await expect(db.sessionTurnMutationReceipt.count({
            where: { sessionId: session.id },
        })).resolves.toBe(1);
    });

    it("does not let a host turn mutation extend a finite snapshot that a viewer can poll", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: "pk-session-turn-finite-route-owner",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const viewer = await db.account.create({
            data: {
                publicKey: "pk-session-turn-finite-route-viewer",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const publicationObservedAt = 1_700_000_000_000;
        const session = await db.session.create({
            data: {
                tag: "session-turn-finite-route",
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ t: "plain", v: {} }),
                agentState: null,
                seq: 1,
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 1,
                materializationPublicationId: "finite-turn-route-publication",
                materializedThroughSourceAt: BigInt(publicationObservedAt),
                publishedThroughServerSeq: 1,
            },
            select: { id: true },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: viewer.id,
                accessLevel: "view",
            },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                localId: "finite-turn-anchor",
                messageRole: "user",
                content: {
                    t: "plain",
                    v: {
                        role: "user",
                        content: { type: "text", text: "published anchor" },
                    },
                },
            },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as any),
            async (app) => {
                const mutation = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/turns/mutations`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                    },
                    payload: {
                        v: 1,
                        sessionId: session.id,
                        mutationId: "finite-route-begin",
                        turnId: "finite-route-turn",
                        action: "begin",
                        provider: "codex",
                        observedAt: 100,
                        transcriptAnchors: { endSeqInclusive: 1 },
                    },
                });

                expect(mutation.statusCode, mutation.body).toBe(400);
                expect(mutation.json()).toEqual({
                    error: "Invalid parameters",
                    code: "session_storage_authority_mismatch",
                });

                const projection = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${session.id}/turns`,
                    headers: { "x-test-user-id": viewer.id },
                });
                expect(projection.statusCode, projection.body).toBe(200);
                expect(projection.json()).toEqual({
                    v: 1,
                    sessionId: session.id,
                    updatedAt: publicationObservedAt,
                    turns: [],
                });
            },
        );

        await expect(db.sessionTurn.count({
            where: { sessionId: session.id },
        })).resolves.toBe(0);
        await expect(db.sessionTurnMutationReceipt.count({
            where: { sessionId: session.id },
        })).resolves.toBe(0);
    });
});
