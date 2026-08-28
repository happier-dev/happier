import { describe, expect, it, vi } from "vitest";

import { loadAutomationSessionLifecycleStatusProjections } from "./automationSessionLifecycleStatusProjection";

function lifecycleTrigger(id: string, sourceTurnId: string, enabled = true) {
    return {
        id,
        automationId: "automation-active",
        kind: "sessionLifecycle",
        enabled,
        revision: 1,
        deletedAt: null,
        sessionLifecycleEvent: "parentTurnCompleted",
        sourceSessionId: "source-session",
        sourceTurnId,
    } as const;
}

describe("Automation Session lifecycle status projection", () => {
    it("batch-derives waiting, paused, terminal source truth, and immutable Run outcomes", async () => {
        const sessionTurnFindMany = vi.fn(async () => [
            { sessionId: "source-session", turnId: "turn-waiting", status: "in_progress" },
            { sessionId: "source-session", turnId: "turn-paused", status: "in_progress" },
            { sessionId: "source-session", turnId: "turn-failed", status: "failed" },
            // The receipt remains terminal truth even if a later recovery path
            // leaves the mutable turn row looking in progress again.
            { sessionId: "source-session", turnId: "turn-cancelled", status: "in_progress" },
            { sessionId: "source-session", turnId: "turn-finished-without-run", status: "completed" },
            { sessionId: "source-session", turnId: "turn-triggered", status: "completed" },
            { sessionId: "source-session", turnId: "turn-running", status: "completed" },
            { sessionId: "source-session", turnId: "turn-finished", status: "completed" },
        ]);
        const receiptFindMany = vi.fn(async () => [
            {
                id: "receipt-cancelled",
                sessionId: "source-session",
                turnId: "turn-cancelled",
                action: "cancel",
            },
        ]);
        const automationRunFindMany = vi.fn(async () => [
            {
                id: "run-triggered",
                state: "queued",
                triggerId: "trigger-triggered",
                causeSessionLifecycleEvent: "parentTurnCompleted",
                causeSourceSessionId: "source-session",
                causeSourceTurnId: "turn-triggered",
            },
            {
                id: "run-running",
                state: "running",
                triggerId: "trigger-running",
                causeSessionLifecycleEvent: "parentTurnCompleted",
                causeSourceSessionId: "source-session",
                causeSourceTurnId: "turn-running",
            },
            {
                id: "run-finished",
                state: "succeeded",
                triggerId: "trigger-finished",
                causeSessionLifecycleEvent: "parentTurnCompleted",
                causeSourceSessionId: "source-session",
                causeSourceTurnId: "turn-finished",
            },
        ]);
        const activeTriggers = [
            lifecycleTrigger("trigger-waiting", "turn-waiting"),
            lifecycleTrigger("trigger-paused", "turn-paused", false),
            lifecycleTrigger("trigger-failed", "turn-failed"),
            lifecycleTrigger("trigger-cancelled", "turn-cancelled"),
            lifecycleTrigger("trigger-unavailable", "turn-unavailable"),
            lifecycleTrigger("trigger-finished-without-run", "turn-finished-without-run"),
            lifecycleTrigger("trigger-triggered", "turn-triggered"),
            lifecycleTrigger("trigger-running", "turn-running"),
            lifecycleTrigger("trigger-finished", "turn-finished"),
        ];

        const projection = await loadAutomationSessionLifecycleStatusProjections({
            automations: [{
                id: "automation-active",
                enabled: true,
                triggers: activeTriggers,
            }] as any,
            tx: {
                sessionTurn: { findMany: sessionTurnFindMany },
                sessionTurnMutationReceipt: { findMany: receiptFindMany },
                automationRun: { findMany: automationRunFindMany },
            } as any,
        });

        expect(Object.fromEntries(projection.get("automation-active") ?? [])).toEqual({
            "trigger-waiting": { state: "waiting", runId: null },
            "trigger-paused": { state: "paused", runId: null },
            "trigger-failed": { state: "sourceFailed", runId: null },
            "trigger-cancelled": { state: "sourceCancelled", runId: null },
            "trigger-unavailable": { state: "sourceUnavailable", runId: null },
            "trigger-finished-without-run": { state: "finished", runId: null },
            "trigger-triggered": { state: "triggered", runId: "run-triggered" },
            "trigger-running": { state: "running", runId: "run-running" },
            "trigger-finished": { state: "finished", runId: "run-finished" },
        });
        expect(sessionTurnFindMany).toHaveBeenCalledTimes(1);
        expect(receiptFindMany).toHaveBeenCalledTimes(1);
        expect(automationRunFindMany).toHaveBeenCalledTimes(1);
    });

    it("derives a globally disabled Automation as paused without changing its trigger", async () => {
        const projection = await loadAutomationSessionLifecycleStatusProjections({
            automations: [{
                id: "automation-paused",
                enabled: false,
                triggers: [{
                    ...lifecycleTrigger("trigger-global-pause", "turn-global-pause"),
                    automationId: "automation-paused",
                }],
            }] as any,
            tx: {
                sessionTurn: { findMany: vi.fn(async () => [{
                    sessionId: "source-session",
                    turnId: "turn-global-pause",
                    status: "in_progress",
                }]) },
                sessionTurnMutationReceipt: { findMany: vi.fn(async () => []) },
                automationRun: { findMany: vi.fn(async () => []) },
            } as any,
        });

        expect(projection.get("automation-paused")?.get("trigger-global-pause")).toEqual({
            state: "paused",
            runId: null,
        });
    });
});
