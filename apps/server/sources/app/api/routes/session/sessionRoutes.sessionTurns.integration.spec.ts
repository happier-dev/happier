import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateBodySchema } from "@happier-dev/protocol";
import { eventRouter } from "@/app/events/eventRouter";
import { publishSessionAfterCommit } from "@/app/session/publishSessionAfterCommit";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

const authentication = createPresentUserSessionAccessAuthentication();

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

    it("acknowledges an HTTP turn mutation on commit, before its client fan-out", async () => {
        const account = await db.account.create({ data: { publicKey: "pk-session-turn-ack", encryptionMode: "plain" }, select: { id: true } });
        const session = await db.session.create({
            data: { tag: "session-turn-ack", accountId: account.id, encryptionMode: "plain",
                metadata: JSON.stringify({ t: "plain", v: {} }), agentState: null },
            select: { id: true },
        });
        let releaseFanOut!: () => void;
        const fanOutHeld = new Promise<void>(resolve => { releaseFanOut = resolve; });
        const emitted: string[] = [];
        // Socket delivery is the network boundary: hold it to observe what the HTTP response waits for.
        const emit = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(async (params) => {
            await fanOutHeld;
            emitted.push(params.userId);
        });
        try {
            await withAuthenticatedTestApp((app) => sessionRoutes(app as any), async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/turns/mutations`,
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { v: 1, sessionId: session.id, mutationId: "begin-ack", turnId: "turn-ack", action: "begin",
                        provider: "codex", observedAt: 100 },
                });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({ success: true, applied: true });
                // Committed and acknowledged; the fan-out is still held and then still delivered.
                expect(await db.sessionTurn.count({ where: { sessionId: session.id, turnId: "turn-ack" } })).toBe(1);
                expect(emitted).toEqual([]);
                releaseFanOut();
                await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(0));
                expect(new Set(emitted)).toEqual(new Set([account.id]));
            });
        } finally {
            releaseFanOut();
            emit.mockRestore();
        }
    });

    it("preserves request-owned pending counts through the terminal HTTP mutation", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-session-turn-pending-clear", encryptionMode: "plain" },
        });
        const session = await db.session.create({
            data: {
                tag: "session-turn-pending-clear", accountId: account.id, encryptionMode: "plain",
                metadata: JSON.stringify({ t: "plain", v: {} }), active: true,
                pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: new Date(150),
            },
        });
        await expect(applySessionTurnMutation({
            actorUserId: account.id, authentication,
            mutation: {
                v: 1, sessionId: session.id, mutationId: "pending-begin", turnId: "turn-pending",
                action: "begin", provider: "codex", observedAt: 100,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        // Keep the real HTTP owner, database, and payload builder beneath the transport boundary.
        const updates = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        try {
            await withAuthenticatedTestApp(sessionRoutes, async (app) => {
                const response = await app.inject({
                    method: "POST", url: `/v1/sessions/${session.id}/turns/mutations`,
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        v: 1, sessionId: session.id, mutationId: "pending-cancel", turnId: "turn-pending",
                        action: "cancel", provider: "codex", observedAt: 200,
                    },
                });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({ success: true, applied: true });
                // A terminal foreground turn cannot settle Session-wide request authority.
                await expect(db.session.findUniqueOrThrow({
                    where: { id: session.id },
                    select: { pendingPermissionRequestCount: true, pendingUserActionRequestCount: true, pendingRequestObservedAt: true },
                })).resolves.toEqual({
                    pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 1, pendingRequestObservedAt: new Date(150),
                });
                const terminalUpdates = updates.mock.calls.filter(([update]) =>
                    update.payload.body.t === "update-session" && update.payload.body.latestTurnStatus === "cancelled",
                );
                expect(terminalUpdates).toHaveLength(1);
                const body = UpdateBodySchema.parse(terminalUpdates[0]![0].payload.body);
                expect(body).not.toHaveProperty("pendingPermissionRequestCount");
                expect(body).not.toHaveProperty("pendingUserActionRequestCount");
                expect(body).not.toHaveProperty("pendingRequestObservedAt");
            });
        } finally {
            updates.mockRestore();
        }
    });

    it.each([
        { pendingAt: 250, newerTurn: false, settledNewerTurn: false, label: "newer request evidence" },
        { pendingAt: 50, newerTurn: false, settledNewerTurn: false, label: "request evidence preceding the turn" },
        { pendingAt: null, newerTurn: false, settledNewerTurn: false, label: "requests without turn-lifetime evidence" },
        { pendingAt: 150, newerTurn: true, settledNewerTurn: false, label: "a newer active foreground turn" },
        { pendingAt: 450, newerTurn: true, settledNewerTurn: true, label: "a newer terminal foreground turn" },
    ])("preserves pending authority for $label on cancellation", async ({ pendingAt, newerTurn, settledNewerTurn }) => {
        const account = await db.account.create({
            data: { publicKey: `pk-pending-neighbor-${pendingAt}-${newerTurn}`, encryptionMode: "plain" },
        });
        const pending = {
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: pendingAt === null ? null : new Date(pendingAt),
        };
        const session = await db.session.create({
            data: {
                tag: `pending-neighbor-${pendingAt}-${newerTurn}`, accountId: account.id,
                encryptionMode: "plain", metadata: JSON.stringify({ t: "plain", v: {} }), active: true,
                ...pending,
            },
        });
        const begin = (turnId: string, observedAt: number) => applySessionTurnMutation({
            actorUserId: account.id, authentication,
            mutation: {
                v: 1, sessionId: session.id, mutationId: `begin-${turnId}`, turnId,
                action: "begin", provider: "codex", observedAt,
            },
        });
        await expect(begin("turn-old", 100)).resolves.toMatchObject({ ok: true, didApply: true });
        if (newerTurn) {
            await expect(begin("turn-new", 300)).resolves.toMatchObject({ ok: true, didApply: true });
            if (settledNewerTurn) {
                await expect(applySessionTurnMutation({
                    actorUserId: account.id, authentication,
                    mutation: {
                        v: 1, sessionId: session.id, mutationId: "complete-new", turnId: "turn-new",
                        action: "complete", provider: "codex", observedAt: 400,
                    },
                })).resolves.toMatchObject({ ok: true, didApply: true });
            }
        }
        // Begin itself never owns pending-request settlement.
        const readPending = () => db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingPermissionRequestCount: true, pendingUserActionRequestCount: true, pendingRequestObservedAt: true },
        });
        await expect(readPending()).resolves.toEqual(pending);
        const updates = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        try {
            await withAuthenticatedTestApp(sessionRoutes, async (app) => {
                const response = await app.inject({
                    method: "POST", url: `/v1/sessions/${session.id}/turns/mutations`,
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        v: 1, sessionId: session.id, mutationId: "cancel-old", turnId: "turn-old",
                        action: "cancel", provider: "codex", observedAt: 200,
                    },
                });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({ success: true, applied: !newerTurn || settledNewerTurn });
                await expect(readPending()).resolves.toEqual(pending);
                // The response follows the commit; the Session's fan-out follows in commit order.
                await publishSessionAfterCommit(session.id, "test barrier", async () => {});
                const terminalUpdates = updates.mock.calls.filter(([update]) =>
                    update.payload.body.t === "update-session" && update.payload.body.latestTurnStatus === "cancelled",
                );
                expect(terminalUpdates).toHaveLength(newerTurn ? 0 : 1);
                for (const [update] of terminalUpdates) {
                    const body = UpdateBodySchema.parse(update.payload.body);
                    expect(body).not.toHaveProperty("pendingPermissionRequestCount");
                    expect(body).not.toHaveProperty("pendingUserActionRequestCount");
                    expect(body).not.toHaveProperty("pendingRequestObservedAt");
                }
            });
        } finally {
            updates.mockRestore();
        }
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
            authentication,
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
            authentication,
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
            authentication,
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
