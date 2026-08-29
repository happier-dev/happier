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

import { startAutomationReplyHandoffWorker } from "./automationReplyHandoffWorker";

describe("Automation reply handoff worker diagnostics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.claimNextAutomationReplyHandoff.mockResolvedValue(null);
        mocks.findNextAutomationReplyHandoffDueAt.mockResolvedValue(null);
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
});
