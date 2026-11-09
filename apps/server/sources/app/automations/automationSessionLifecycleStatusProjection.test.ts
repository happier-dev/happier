import { describe, expect, it, vi } from "vitest";

import { loadAutomationSessionLifecycleStatusProjections } from "./automationSessionLifecycleStatusProjection";

function lifecycleTrigger(
    id: string,
    sourceTurnId: string,
    enabled = true,
    consumption: Readonly<{
        remainingOccurrences?: number;
        events?: readonly string[];
        revision?: number;
    }> = {},
) {
    return {
        id,
        automationId: "automation-active",
        kind: "sessionLifecycle",
        enabled,
        revision: consumption.revision ?? 1,
        deletedAt: null,
        sessionLifecycleEventsJson: JSON.stringify(
            consumption.events ?? ["parentTurnCompleted"],
        ),
        sessionLifecyclePolicyKind: "currentTurn",
        sessionLifecycleMatchCount: null,
        // An exact-turn registration keeps one occurrence until it is consumed.
        remainingOccurrences: consumption.remainingOccurrences ?? 1,
        sourceSessionId: "source-session",
        sourceTurnId,
    } as const;
}

/** An exact-turn registration that already consumed its single occurrence. */
function consumedLifecycleTrigger(id: string, sourceTurnId: string) {
    return lifecycleTrigger(id, sourceTurnId, true, { remainingOccurrences: 0 });
}

describe("Automation Session lifecycle status projection", () => {
    it("batch-derives waiting, paused, terminal source truth, and immutable Run outcomes", async () => {
        const sessionTurnFindMany = vi.fn(async () => [
            { sessionId: "source-session", turnId: "turn-waiting", status: "in_progress" },
            { sessionId: "source-session", turnId: "turn-paused", status: "in_progress" },
            { sessionId: "source-session", turnId: "turn-failed", status: "failed" },
            { sessionId: "source-session", turnId: "turn-failed-with-run", status: "failed" },
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
            {
                id: "receipt-failed-with-run",
                sessionId: "source-session",
                turnId: "turn-failed-with-run",
                action: "fail",
            },
        ]);
        const automationRuns = [
            // Workflow control states retain their physical identity while
            // the public Automation status uses its canonical active state.
            {
                id: "workflow-run-interrupted",
                state: "interrupted",
                triggerId: "trigger-running",
                causeSessionLifecycleEvent: "parentTurnCompleted",
                causeSourceSessionId: "source-session",
                causeSourceTurnId: "turn-running",
            },
            {
                id: "run-triggered",
                state: "queued",
                triggerId: "trigger-triggered",
                causeSessionLifecycleEvent: "parentTurnCompleted",
                causeSourceSessionId: "source-session",
                causeSourceTurnId: "turn-triggered",
            },
            {
                id: "run-finished",
                state: "succeeded",
                triggerId: "trigger-finished",
                causeSessionLifecycleEvent: "parentTurnCompleted",
                causeSourceSessionId: "source-session",
                causeSourceTurnId: "turn-finished",
            },
            // The trigger selected the failure Event and really produced this
            // Run from it. Terminal source truth must not hide it.
            {
                id: "run-failed-with-run",
                state: "succeeded",
                triggerId: "trigger-failed-with-run",
                causeSessionLifecycleEvent: "parentTurnFailed",
                causeSourceSessionId: "source-session",
                causeSourceTurnId: "turn-failed-with-run",
            },
        ];
        const activeTriggers = [
            lifecycleTrigger("trigger-waiting", "turn-waiting"),
            lifecycleTrigger("trigger-paused", "turn-paused", false),
            lifecycleTrigger("trigger-failed", "turn-failed"),
            lifecycleTrigger("trigger-failed-with-run", "turn-failed-with-run", true, {
                events: ["parentTurnCompleted", "parentTurnFailed"],
                remainingOccurrences: 0,
            }),
            lifecycleTrigger("trigger-cancelled", "turn-cancelled"),
            lifecycleTrigger("trigger-unavailable", "turn-unavailable"),
            consumedLifecycleTrigger("trigger-finished-without-run", "turn-finished-without-run"),
            consumedLifecycleTrigger("trigger-triggered", "turn-triggered"),
            consumedLifecycleTrigger("trigger-running", "turn-running"),
            consumedLifecycleTrigger("trigger-finished", "turn-finished"),
        ];

        const projection = await loadAutomationSessionLifecycleStatusProjections({
            automations: [{
                id: "automation-active",
                enabled: true,
                triggers: activeTriggers,
            }] as any,
            tx: {
                session: { findMany: vi.fn(async () => [{ id: "source-session" }]) },
                sessionTurn: { findMany: sessionTurnFindMany },
                sessionTurnMutationReceipt: { findMany: receiptFindMany },
                $queryRaw: vi.fn(async () => automationRuns),
            } as any,
        });

        expect(Object.fromEntries(projection.get("automation-active") ?? [])).toEqual({
            "trigger-waiting": { state: "waiting", runId: null },
            "trigger-paused": { state: "paused", runId: null },
            "trigger-failed": { state: "sourceFailed", runId: null },
            "trigger-failed-with-run": { state: "finished", runId: "run-failed-with-run" },
            "trigger-cancelled": { state: "sourceCancelled", runId: null },
            "trigger-unavailable": { state: "sourceUnavailable", runId: null },
            "trigger-finished-without-run": { state: "finished", runId: null },
            "trigger-triggered": { state: "triggered", runId: "run-triggered" },
            "trigger-running": { state: "running", runId: "workflow-run-interrupted" },
            "trigger-finished": { state: "finished", runId: "run-finished" },
        });
    });

    it("never binds a Run from an earlier registration of the same exact turn", async () => {
        const sourceTurnId = "turn-rearmed";
        // The prior registration selected the attention Event and produced this
        // Run while the same turn was still in progress. The current
        // registration selects a different Event and has its full budget, so
        // it is armed and has produced nothing yet. The Run's trigger revision
        // cannot decide this: every trigger write advances it, including the
        // pause/resume edits that legitimately keep a produced Run bound.
        const priorRegistrationRun = {
            id: "run-prior-registration",
            state: "running",
            triggerId: "trigger-rearmed",
            causeSessionLifecycleEvent: "userActionRequired",
            causeSourceSessionId: "source-session",
            causeSourceTurnId: sourceTurnId,
        };
        const projection = await loadAutomationSessionLifecycleStatusProjections({
            automations: [{
                id: "automation-active",
                enabled: true,
                triggers: [lifecycleTrigger("trigger-rearmed", sourceTurnId, true, {
                    events: ["parentTurnCompleted"],
                    remainingOccurrences: 1,
                    revision: 7,
                })],
            }] as any,
            tx: {
                session: { findMany: vi.fn(async () => [{ id: "source-session" }]) },
                sessionTurn: { findMany: vi.fn(async () => [{
                    sessionId: "source-session",
                    turnId: sourceTurnId,
                    status: "in_progress",
                }]) },
                sessionTurnMutationReceipt: { findMany: vi.fn(async () => []) },
                $queryRaw: vi.fn(async () => [priorRegistrationRun]),
            } as any,
        });

        expect(projection.get("automation-active")?.get("trigger-rearmed")).toEqual({
            state: "waiting",
            runId: null,
        });
    });

    it("keeps a produced Run bound to its exact-turn trigger after a later pause", async () => {
        const sourceTurnId = "turn-paused-after-run";
        const projection = await loadAutomationSessionLifecycleStatusProjections({
            automations: [{
                id: "automation-active",
                enabled: true,
                triggers: [lifecycleTrigger(
                    "trigger-paused-after-run",
                    sourceTurnId,
                    false,
                    // Pause preserves the consumed budget and the selected
                    // Events, so the Run this registration produced stays its
                    // outcome.
                    { remainingOccurrences: 0, revision: 9 },
                )],
            }] as any,
            tx: {
                session: { findMany: vi.fn(async () => [{ id: "source-session" }]) },
                sessionTurn: { findMany: vi.fn(async () => [{
                    sessionId: "source-session",
                    turnId: sourceTurnId,
                    status: "completed",
                }]) },
                sessionTurnMutationReceipt: { findMany: vi.fn(async () => []) },
                $queryRaw: vi.fn(async () => [{
                    id: "run-paused-after-run",
                    state: "succeeded",
                    triggerId: "trigger-paused-after-run",
                    causeSessionLifecycleEvent: "parentTurnCompleted",
                    causeSourceSessionId: "source-session",
                    causeSourceTurnId: sourceTurnId,
                }]),
            } as any,
        });

        expect(projection.get("automation-active")?.get("trigger-paused-after-run")).toEqual({
            state: "finished",
            runId: "run-paused-after-run",
        });
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
                session: { findMany: vi.fn(async () => [{ id: "source-session" }]) },
                sessionTurn: { findMany: vi.fn(async () => [{
                    sessionId: "source-session",
                    turnId: "turn-global-pause",
                    status: "in_progress",
                }]) },
                sessionTurnMutationReceipt: { findMany: vi.fn(async () => []) },
                $queryRaw: vi.fn(async () => []),
            } as any,
        });

        expect(projection.get("automation-paused")?.get("trigger-global-pause")).toEqual({
            state: "paused",
            runId: null,
        });
    });
});
