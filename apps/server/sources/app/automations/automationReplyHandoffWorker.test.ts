import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    warn: vi.fn(),
    claimNextAutomationReplyHandoff: vi.fn(),
    findNextAutomationReplyHandoffDueAt: vi.fn(),
    settleAutomationReplyHandoff: vi.fn(),
}));

vi.mock("@/utils/logging/log", () => ({ warn: mocks.warn }));
vi.mock("./automationReplyHandoffService", () => ({
    claimNextAutomationReplyHandoff: mocks.claimNextAutomationReplyHandoff,
    findNextAutomationReplyHandoffDueAt: mocks.findNextAutomationReplyHandoffDueAt,
    settleAutomationReplyHandoff: mocks.settleAutomationReplyHandoff,
    DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS: 10_000,
}));

import {
    runAutomationReplyHandoffWorkerPass,
    startAutomationReplyHandoffWorker,
} from "./automationReplyHandoffWorker";

const NOW = new Date("2026-08-29T08:00:00.000Z");
const RETRY_AT = new Date(NOW.getTime() + 10_000);

function createClaim(attempt: number) {
    return {
        accountId: "account-1",
        automationId: "automation-1",
        runId: "run-1",
        handoffId: "handoff-1",
        occurrenceKey: "A".repeat(43),
        attempt,
        accountCurrentness: {
            mode: "plain" as const,
            version: 9,
            contentKeyFingerprint: null,
        },
        runRevision: attempt,
        resultEnvelope: JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    accountId: "account-1",
                    automationId: "automation-1",
                    runId: "run-1",
                    handoffId: "handoff-1",
                },
                result: { v: 1, kind: "text", text: "Finished" },
            },
        }),
        replyContextEnvelope: JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    automationId: "automation-1",
                    occurrenceKey: "A".repeat(43),
                },
                templateVersion: 1,
                opaqueContext: { conversationId: "conversation-1", messageId: "message-1" },
            },
        }),
        target: {
            actionPluginId: "happier.channels",
            actionLocalId: "automation/result-deliver-v1",
            machineId: "machine-1",
            machineInstallationId: "installation-1",
            materializationId: "materialization-1",
        },
    };
}

describe("Automation reply handoff worker diagnostics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.claimNextAutomationReplyHandoff.mockResolvedValue(null);
        mocks.findNextAutomationReplyHandoffDueAt.mockResolvedValue(null);
        mocks.settleAutomationReplyHandoff.mockResolvedValue({ applied: true });
    });

    it("warns on a due scan failure without logging the database error", async () => {
        const privateDetails = "private-prompt result-envelope account-secret";
        mocks.findNextAutomationReplyHandoffDueAt
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error(privateDetails));

        const worker = startAutomationReplyHandoffWorker({
            dispatch: vi.fn(),
            idlePollMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(1));
        await worker.stop();

        expect(mocks.warn).toHaveBeenCalledWith(
            {
                module: "automation-reply-handoff-worker",
                operation: "due-scan",
            },
            "Automation reply handoff worker due scan failed",
        );
        expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(privateDetails);
    });

    it("warns on a worker pass failure and continues to the next schedule", async () => {
        const privateDetails = "private-prompt result-envelope account-secret";
        mocks.claimNextAutomationReplyHandoff.mockRejectedValueOnce(new Error(privateDetails));

        const worker = startAutomationReplyHandoffWorker({
            dispatch: vi.fn(),
            idlePollMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(1));
        await worker.stop();

        expect(mocks.warn).toHaveBeenCalledWith(
            {
                module: "automation-reply-handoff-worker",
                operation: "pass",
            },
            "Automation reply handoff worker pass failed",
        );
        expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(privateDetails);
        expect(mocks.findNextAutomationReplyHandoffDueAt).toHaveBeenCalledTimes(1);
    });

    it.each(["throws", "no-ops"] as const)(
        "uses the idle progress floor when a pass %s and leaves an overdue handoff",
        async (passOutcome) => {
            vi.useFakeTimers();
            try {
                if (passOutcome === "throws") {
                    mocks.claimNextAutomationReplyHandoff.mockRejectedValueOnce(new Error("transient claim failure"));
                }
                mocks.findNextAutomationReplyHandoffDueAt.mockResolvedValue(new Date(0));

                const worker = startAutomationReplyHandoffWorker({
                    dispatch: vi.fn(),
                    idlePollMs: 60_000,
                });
                await vi.advanceTimersByTimeAsync(1);

                expect(mocks.claimNextAutomationReplyHandoff).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(59_999);
                expect(mocks.claimNextAutomationReplyHandoff).toHaveBeenCalledTimes(2);
                await worker.stop();
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it("uses the absolute handoff-attempt budget when availability is followed by malformed output", async () => {
        mocks.claimNextAutomationReplyHandoff
            .mockResolvedValueOnce(createClaim(1))
            .mockResolvedValueOnce(createClaim(2));
        const dispatch = vi.fn()
            .mockResolvedValueOnce({ kind: "unavailable", code: "targetUnavailable" })
            .mockResolvedValueOnce({ kind: "malformed-result" });

        await runAutomationReplyHandoffWorkerPass({ now: NOW, dispatch });
        await runAutomationReplyHandoffWorkerPass({ now: RETRY_AT, dispatch });

        expect(mocks.settleAutomationReplyHandoff).toHaveBeenNthCalledWith(1, expect.objectContaining({
            claim: expect.objectContaining({ handoffId: "handoff-1", attempt: 1 }),
            outcome: { kind: "retry", retryAfterMs: 10_000 },
        }));
        expect(mocks.settleAutomationReplyHandoff).toHaveBeenNthCalledWith(2, expect.objectContaining({
            claim: expect.objectContaining({ handoffId: "handoff-1", attempt: 2 }),
            outcome: { kind: "blocked" },
        }));
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(dispatch.mock.calls[1]?.[0]).toEqual(dispatch.mock.calls[0]?.[0]);
    });

    it("rejoins one malformed result with the same frozen request and blocks the second", async () => {
        mocks.claimNextAutomationReplyHandoff
            .mockResolvedValueOnce(createClaim(1))
            .mockResolvedValueOnce(createClaim(2));
        const dispatch = vi.fn().mockResolvedValue({ kind: "malformed-result" });

        await runAutomationReplyHandoffWorkerPass({ now: NOW, dispatch });
        await runAutomationReplyHandoffWorkerPass({ now: RETRY_AT, dispatch });

        expect(mocks.settleAutomationReplyHandoff).toHaveBeenNthCalledWith(1, expect.objectContaining({
            outcome: { kind: "retry", retryAfterMs: 10_000 },
        }));
        expect(mocks.settleAutomationReplyHandoff).toHaveBeenNthCalledWith(2, expect.objectContaining({
            outcome: { kind: "blocked" },
        }));
        expect(dispatch.mock.calls[1]?.[0]).toEqual(dispatch.mock.calls[0]?.[0]);
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
            target: {
                accountId: "account-1",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
                actionRef: { pluginId: "happier.channels", localId: "automation/result-deliver-v1" },
            },
            handoff: {
                handoffId: "handoff-1",
                resultEnvelope: expect.any(Object),
                replyContextEnvelope: expect.any(Object),
            },
        });
    });
});
