import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import {
    eventRouter,
    type ClientConnection,
    type UpdatePayload,
} from "@/app/events/eventRouter";

import { emitAutomationRunTransition } from "./automationChangePublisher";
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
        automationId: "automation-1",
        accountId: "account-1",
        state,
        originKind: "scheduled",
        originOccurredAt: null,
        occurrenceKey: null,
        occurrenceEvidenceEqualityTag: null,
        originSourceSelectorId: null,
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
        replyHandoffReceiptEnvelope: null,
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
        contentRemovedAt: null,
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
                t: "automation-run-updated",
                state: "outcome_uncertain",
            }),
            expect.objectContaining({
                t: "automation-run-state-changed",
                previousState: "running",
                currentState: "outcome_uncertain",
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
            .mockImplementationOnce(() => {
                throw new Error("legacy publisher failed");
            })
            .mockImplementationOnce(() => undefined);

        expect(() => emitAutomationRunTransition({
            accountId: "account-1",
            run: createRun("running"),
            previousState: "claimed",
            cursor: 1,
        })).toThrow("legacy publisher failed");
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
    });
});
