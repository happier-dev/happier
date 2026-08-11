import { describe, expect, it } from "vitest";

import type { SessionRuntimeIssueV1, SessionTurnV1 } from "@happier-dev/protocol";

import { applySessionTurnMutationToTurns } from "./applySessionTurnMutation";

const usageLimitIssue: SessionRuntimeIssueV1 = {
    v: 1,
    scope: "primary_session",
    status: "failed",
    code: "usage_limit",
    source: "usage_limit",
    occurredAt: 200,
    provider: "codex",
    providerTurnId: "provider-turn-1",
    sanitizedPreview: "Limit reached",
    usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: "account",
        recoverability: "switch_account",
        connectedService: {
            serviceId: "openai-codex",
            profileId: "old-profile",
            groupId: "codex-group",
        },
    },
};

function failedUsageLimitTurn(overrides: Partial<SessionTurnV1> = {}): SessionTurnV1 {
    return {
        turnId: "turn-1",
        provider: "codex",
        providerTurnId: "provider-turn-1",
        status: "failed",
        startedAt: 100,
        updatedAt: 200,
        terminalAt: 200,
        lastRuntimeIssue: usageLimitIssue,
        lastMutationId: "mutation-failed",
        ...overrides,
    };
}

describe("applySessionTurnMutationToTurns", () => {
    it("lets newer matching task-started evidence supersede a stale failed runtime issue", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn()],
            appliedAt: 301,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-recovered-start",
                action: "begin",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                observedAt: 300,
            },
        });

        expect(decision.apply).toBe(true);
        expect(decision.materialized).toEqual({
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: 300,
            lastRuntimeIssue: null,
        });
        if (decision.apply) {
            expect(decision.changedTurn).toEqual(expect.objectContaining({
                status: "in_progress",
                startedAt: 300,
                updatedAt: 300,
                lastRuntimeIssue: null,
            }));
            expect(decision.changedTurn).not.toHaveProperty("terminalAt");
        }
    });

    it("unions, deduplicates, and sorts transcript anchor append deltas", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [{
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                status: "in_progress",
                startedAt: 100,
                updatedAt: 100,
                transcriptAnchors: { userMessageSeqs: [13, 12, 12] },
            }],
            appliedAt: 151,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-append-anchor-delta",
                action: "append_transcript_anchors",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                observedAt: 150,
                transcriptAnchors: { userMessageSeqs: [14, 13] },
            },
        });

        expect(decision.apply).toBe(true);
        if (decision.apply) {
            expect(decision.changedTurn.transcriptAnchors).toEqual({ userMessageSeqs: [12, 13, 14] });
        }
    });

    it("lets newer matching task-complete evidence supersede a stale failed runtime issue", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn()],
            appliedAt: 301,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-recovered-complete",
                action: "complete",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                observedAt: 300,
            },
        });

        expect(decision.apply).toBe(true);
        expect(decision.materialized).toEqual({
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 300,
            lastRuntimeIssue: null,
        });
    });

    it("keeps a stale failed runtime issue when matching lifecycle evidence is older", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn()],
            appliedAt: 201,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-old-start",
                action: "begin",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                observedAt: 150,
            },
        });

        expect(decision.apply).toBe(false);
        expect(decision.materialized.latestTurnStatus).toBe("failed");
        expect(decision.materialized.lastRuntimeIssue).toEqual(usageLimitIssue);
    });

    it("keeps a stale failed runtime issue when lifecycle evidence is unrelated", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn()],
            appliedAt: 301,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-unrelated-start",
                action: "begin",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-2",
                observedAt: 300,
            },
        });

        expect(decision.apply).toBe(false);
        expect(decision.materialized.latestTurnStatus).toBe("failed");
        expect(decision.materialized.lastRuntimeIssue).toEqual(usageLimitIssue);
    });

    // Daemon-observed exit settlement (incident cmq7pyqkj, Lane N1): the daemon settles a dead
    // runner's open turn with an `end_session` mutation observed at the child-exit time. The
    // settlement must cancel a turn that was already open when the runner died, but must NEVER
    // cancel a NEWER turn begun by the replacement runner after the observed exit.
    it("cancels an open turn via end_session observed after the turn began", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn({ status: "in_progress", startedAt: 100, updatedAt: 100, terminalAt: undefined, lastRuntimeIssue: null })],
            appliedAt: 501,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "daemon-exit-settlement-1",
                action: "end_session",
                observedAt: 500,
            },
        });

        expect(decision.apply).toBe(true);
        expect(decision.materialized.latestTurnStatus).toBe("cancelled");
    });

    it("does not cancel a newer turn via a stale end_session observed before the turn began", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-2",
            turns: [{
                turnId: "turn-2",
                status: "in_progress",
                startedAt: 600,
                updatedAt: 600,
                lastRuntimeIssue: null,
                lastMutationId: "mutation-begin-2",
            }],
            appliedAt: 701,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "daemon-exit-settlement-stale",
                action: "end_session",
                observedAt: 500,
            },
        });

        expect(decision.apply).toBe(false);
        expect(decision.materialized.latestTurnStatus).toBe("in_progress");
    });

    it("cancels an exact historical in-progress turn without moving the live successor", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-2",
            turns: [
                {
                    turnId: "turn-1",
                    status: "in_progress",
                    startedAt: 100,
                    updatedAt: 100,
                },
                {
                    turnId: "turn-2",
                    status: "in_progress",
                    startedAt: 300,
                    updatedAt: 300,
                },
            ],
            appliedAt: 401,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "exact-end-historical",
                action: "end_session",
                turnId: "turn-1",
                observedAt: 200,
            },
        });

        expect(decision.apply).toBe(true);
        expect(decision.latestTurnId).toBe("turn-2");
        expect(decision.turns.find((turn) => turn.turnId === "turn-1")?.status).toBe("cancelled");
        expect(decision.turns.find((turn) => turn.turnId === "turn-2")?.status).toBe("in_progress");
        expect(decision.materialized.latestTurnStatus).toBe("in_progress");
    });

    it("returns exact missing-turn provisionally and only already-cancelled as duplicate-terminal", () => {
        const base = {
            currentLatestTurnId: null,
            appliedAt: 401,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "exact-end-missing",
                action: "end_session",
                turnId: "turn-1",
                observedAt: 200,
            },
        } as const;

        const missing = applySessionTurnMutationToTurns({ ...base, turns: [] });
        expect(missing.apply).toBe(false);
        expect(missing.receipt.decision).toBe("missing-turn");

        const cancelled = applySessionTurnMutationToTurns({
            ...base,
            currentLatestTurnId: "turn-1",
            turns: [{
                turnId: "turn-1",
                status: "cancelled",
                startedAt: 100,
                updatedAt: 150,
                terminalAt: 150,
            }],
        });
        expect(cancelled.apply).toBe(false);
        expect(cancelled.receipt.decision).toBe("duplicate-terminal");
    });

    it.each(["completed", "failed"] as const)("acknowledges an exact retry against an already-%s target without rewriting it", (status) => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [{
                turnId: "turn-1",
                status,
                startedAt: 100,
                updatedAt: 150,
                terminalAt: 150,
            }],
            appliedAt: 401,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: `exact-end-${status}`,
                action: "end_session",
                turnId: "turn-1",
                observedAt: 200,
            },
        });

        expect(decision.apply).toBe(false);
        expect(decision.receipt.decision).toBe("duplicate-terminal");
        expect(decision.turns).toEqual([expect.objectContaining({
            turnId: "turn-1",
            status,
            updatedAt: 150,
            terminalAt: 150,
        })]);
    });

    it("keeps an exact target started after observedAt non-positive", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [{
                turnId: "turn-1",
                status: "in_progress",
                startedAt: 300,
                updatedAt: 300,
            }],
            appliedAt: 401,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "exact-end-before-start",
                action: "end_session",
                turnId: "turn-1",
                observedAt: 200,
            },
        });

        expect(decision.apply).toBe(false);
        expect(decision.receipt.decision).toBe("stale-terminal");
    });

    it("touches the active turn so in-progress freshness follows trusted runtime progress", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn({
                status: "in_progress",
                startedAt: 100,
                updatedAt: 100,
                terminalAt: undefined,
                lastRuntimeIssue: null,
            })],
            appliedAt: 181,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "active-touch-1",
                action: "touch_active",
                turnId: "turn-1",
                provider: "codex",
                observedAt: 180,
            },
        });

        expect(decision.apply).toBe(true);
        expect(decision.materialized).toEqual({
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: 180,
            lastRuntimeIssue: null,
        });
        if (decision.apply) {
            expect(decision.changedTurn).toEqual(expect.objectContaining({
                status: "in_progress",
                startedAt: 100,
                updatedAt: 180,
                lastMutationId: "active-touch-1",
            }));
        }
    });

    it("ignores stale active touches for non-current or terminal turns", () => {
        const terminalDecision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn({ status: "completed", lastRuntimeIssue: null })],
            appliedAt: 301,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "terminal-touch",
                action: "touch_active",
                turnId: "turn-1",
                observedAt: 300,
            },
        });
        expect(terminalDecision.apply).toBe(false);

        const oldTurnDecision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-2",
            turns: [
                failedUsageLimitTurn({ status: "in_progress", terminalAt: undefined, lastRuntimeIssue: null }),
                {
                    turnId: "turn-2",
                    status: "in_progress",
                    startedAt: 250,
                    updatedAt: 250,
                },
            ],
            appliedAt: 301,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "old-turn-touch",
                action: "touch_active",
                turnId: "turn-1",
                observedAt: 300,
            },
        });
        expect(oldTurnDecision.apply).toBe(false);
    });

    it("ignores out-of-order active touches that would move in-progress freshness backwards", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn({
                status: "in_progress",
                startedAt: 100,
                updatedAt: 500,
                terminalAt: undefined,
                lastRuntimeIssue: null,
                lastMutationId: "active-touch-newer",
            })],
            appliedAt: 601,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "active-touch-older",
                action: "touch_active",
                turnId: "turn-1",
                provider: "codex",
                observedAt: 450,
            },
        });

        expect(decision.apply).toBe(false);
        expect(decision.materialized).toEqual({
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: 500,
            lastRuntimeIssue: null,
        });
    });
});
