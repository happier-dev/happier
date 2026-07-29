import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
});
