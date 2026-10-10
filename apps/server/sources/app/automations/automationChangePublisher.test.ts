import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import {
    eventRouter,
    type ClientConnection,
    type UpdatePayload,
} from "@/app/events/eventRouter";

import { emitAutomationRunTransition, emitAutomationRunUpdatedToMachineOnly } from "./automationChangePublisher";
import type { AutomationRunItem } from "./automationTypes";

function createMachineObserver(updates: UpdatePayload[]): ClientConnection {
    const socket = {
        emit(event: string, payload: UpdatePayload) {
            if (event === "update") updates.push(payload);
        },
    } as unknown as Socket;
    return {
        connectionType: "machine-scoped",
        userId: "account-1",
        machineId: "machine-1",
        socket,
    };
}

function createRun(state: AutomationRunItem["state"]): AutomationRunItem {
    const now = new Date("2026-08-11T12:00:00.000Z");
    return {
        id: "run-1",
        originKind: "automation",
        automationId: "automation-1",
        originSessionId: null,
        accountId: "account-1",
        state,
        triggerId: "trigger-1",
        causeKind: "trigger",
        causeTriggerKind: "schedule",
        causeTriggerRevision: 1,
        causeOccurredAt: now,
        causeEventPluginId: null,
        causeEventLocalId: null,
        causeScheduledFor: now,
        causeSessionLifecycleEvent: null,
        causeSourceSessionId: null,
        causeSourceTurnId: null,
        causeRunLifecycleEvidenceJson: null,
        causeOriginRunId: null,
        causeSessionLifecycleRequestId: null,
        causeSessionLifecycleRequestKind: null,
        causeSessionLifecyclePolicyKind: null,
        causeSessionLifecycleConfiguredCount: null,
        occurrenceKey: "A".repeat(43),
        legacyManualIdempotencyKey: null,
        occurrenceEvidenceEqualityTag: null,
        causeSourceSelectorId: null,
        triggerEvidenceEnvelope: null,
        executionInputEnvelope: null,
        executionDispatchState: null,
        executionAttempt: 0,
        executionDispatchCommittedAt: null,
        executionDispatchDueAt: null,
        executionNativeRunId: null,
        executionNativeCallId: null,
        executionNativeSidechainId: null,
        resultEnvelope: null,
        replyContextEnvelope: null,
        replyHandoffActionPluginId: null,
        replyHandoffActionLocalId: null,
        replyHandoffTargetMachineId: null,
        replyHandoffTargetMachineInstallationId: null,
        replyHandoffTargetMaterializationId: null,
        replyHandoffId: null,
        replyHandoffState: "none",
        replyHandoffAttempt: 0,
        replyHandoffDueAt: null,
        scheduledAt: now,
        dueAt: now,
        claimedAt: null,
        startedAt: now,
        finishedAt: null,
        claimedByMachineId: "machine-1",
        leaseExpiresAt: now,
        attempt: 1,
        revision: 1,
        summaryCiphertext: null,
        errorCode: null,
        errorMessage: null,
        producedSessionId: null,
        createdAt: now,
        updatedAt: now,
    };
}

describe("Automation Run transition publisher", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        eventRouter.clearIo();
    });

    it("never projects a null previous state except for an initial queued Run", () => {
        const updates: UpdatePayload[] = [];
        const observer = createMachineObserver(updates);
        eventRouter.addConnection("account-1", observer);
        try {
            emitAutomationRunTransition({
                accountId: "account-1",
                run: createRun("running"),
                previousState: null,
                cursor: 1,
            });

            expect(updates).toEqual([]);
        } finally {
            eventRouter.removeConnection("account-1", observer);
        }
    });

    it("keeps outcome_uncertain on the legacy invalidation alongside the lifecycle carrier", () => {
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");

        emitAutomationRunTransition({
            accountId: "account-1",
            run: createRun("outcome_uncertain"),
            previousState: "running",
            cursor: 1,
        });

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate.mock.calls.map(([update]) => update.payload.body)).toEqual([
            expect.objectContaining({
                t: "automation-run-state-changed",
                runCause: expect.objectContaining({
                    kind: "trigger",
                    triggerId: "trigger-1",
                    triggerKind: "schedule",
                }),
                previousState: "running",
                currentState: "outcome_uncertain",
            }),
            expect.objectContaining({
                t: "automation-run-updated",
                state: "outcome_uncertain",
            }),
        ]);
    });

    it("keeps the legacy invalidation but suppresses a same-state lifecycle edge", () => {
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");

        emitAutomationRunTransition({
            accountId: "account-1",
            run: createRun("cancelled"),
            previousState: "cancelled",
            cursor: 1,
        });

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                body: expect.objectContaining({
                    t: "automation-run-updated",
                    state: "cancelled",
                }),
            }),
        }));
    });

    it("attempts the machine transition even when the legacy update publisher fails", () => {
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate")
            .mockImplementationOnce(() => undefined)
            .mockImplementationOnce(() => {
                throw new Error("legacy publisher failed");
            });

        expect(() => emitAutomationRunTransition({
            accountId: "account-1",
            run: createRun("running"),
            previousState: "claimed",
            cursor: 1,
        })).toThrow("legacy publisher failed");
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
    });

    it("distinguishes user cancellation from lease-expiry uncertainty on the lifecycle carrier", () => {
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");

        emitAutomationRunTransition({
            accountId: "account-1",
            run: createRun("outcome_uncertain"),
            previousState: "running",
            cursor: 1,
            transitionCause: "cancelledWhileRunning",
        });
        emitAutomationRunTransition({
            accountId: "account-1",
            run: createRun("outcome_uncertain"),
            previousState: "claimed",
            cursor: 2,
        });

        const lifecycleBodies = emitUpdate.mock.calls
            .map(([update]) => update.payload.body)
            .filter((body) => body.t === "automation-run-state-changed");
        expect(lifecycleBodies[0]).toEqual(expect.objectContaining({
            transitionCause: "cancelledWhileRunning",
        }));
        expect(lifecycleBodies[1]).not.toHaveProperty("transitionCause");
    });

    it("targets the owning machine with direct Workflow cancellation control without fabricating an Automation id", () => {
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");
        const run = createRun("running");

        emitAutomationRunUpdatedToMachineOnly({
            accountId: "account-1",
            machineId: "machine-1",
            run: { ...run, automationId: null, state: "interrupted" },
            cursor: 7,
            workflowControl: "cancel_requested",
        });

        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: { type: "machine-only", machineId: "machine-1" },
            payload: expect.objectContaining({
                seq: 7,
                body: expect.objectContaining({
                    t: "automation-run-updated",
                    runId: "run-1",
                    automationId: null,
                    state: "running",
                    targetMachineId: "machine-1",
                    workflowControl: "cancel_requested",
                }),
            }),
        }));
    });
});
