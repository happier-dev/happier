import { beforeEach, describe, expect, it } from "vitest";

import {
    applySessionTurnMutation,
    buildUpdateSessionUpdate,
    createSessionRouteTestBuilder,
    emitUpdate,
    resetSessionRouteMocks,
    txSessionFindFirst,
    txSessionTurnFindMany,
} from "./sessionRoutes.testkit";

describe("sessionRoutes session turns", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("applies a session turn mutation and fans out materialized turn fields", async () => {
        applySessionTurnMutation.mockResolvedValue({
            ok: true,
            didApply: true,
            receipt: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
            participantCursors: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            badgeAttentionChanged: false,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/turns/mutations");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                agentId: "codex",
                agentTurnId: "provider-turn-1",
                observedAt: 123,
            },
        });

        expect(applySessionTurnMutation).toHaveBeenCalledWith({
            actorUserId: "u1",
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                agentId: "codex",
                agentTurnId: "provider-turn-1",
                observedAt: 123,
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 10, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 11, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(res).toEqual({
            success: true,
            applied: true,
            receipt: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
        });
    });

    it("rejects mismatched session ids before applying the mutation", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/turns/mutations");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                v: 1,
                sessionId: "s2",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                observedAt: 123,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(res).toEqual({ error: "Invalid parameters" });
        expect(applySessionTurnMutation).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns a bounded session turns projection from server-readable rows", async () => {
        txSessionFindFirst.mockResolvedValue({
            latestTurnId: "turn-1",
            updatedAt: new Date(200),
        });
        txSessionTurnFindMany.mockResolvedValue([
            {
                turnId: "turn-1",
                agentId: "codex",
                agentTurnId: "provider-turn-1",
                status: "completed",
                startedAt: BigInt(100),
                updatedAt: BigInt(200),
                terminalAt: BigInt(200),
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 5, endSeqInclusive: 8 }),
                rollbackState: "eligible",
                rollbackReason: "provider checkpoint",
                agentRollbackOrdinal: 2,
                rollbackUpdatedAt: BigInt(201),
                lastMutationId: "mutation-1",
            },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/turns");
        expect(route.routeExists).toBe(true);
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
        });

        expect(txSessionTurnFindMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                sessionId: "s1",
                session: expect.objectContaining({ id: "s1" }),
            }),
            orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
        });
        expect(res).toEqual({
            v: 1,
            sessionId: "s1",
            latestTurnId: "turn-1",
            updatedAt: 200,
            turns: [
                {
                    turnId: "turn-1",
                    agentId: "codex",
                    agentTurnId: "provider-turn-1",
                    status: "completed",
                    startedAt: 100,
                    updatedAt: 200,
                    terminalAt: 200,
                    lastRuntimeIssue: null,
                    transcriptAnchors: { startUserMessageSeq: 5, endSeqInclusive: 8 },
                    rollback: {
                        state: "eligible",
                        reason: "provider checkpoint",
                        agentRollbackOrdinal: 2,
                        updatedAt: 201,
                    },
                    lastMutationId: "mutation-1",
                },
            ],
        });
    });
});
