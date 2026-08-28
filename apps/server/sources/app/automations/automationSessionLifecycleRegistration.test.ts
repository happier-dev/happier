import { describe, expect, it, vi } from "vitest";
import type { Tx } from "@/storage/inTx";
import {
    AutomationSessionLifecycleRegistrationValidationError,
    validateSessionLifecycleExecutionTargetInequality,
    validateSessionLifecycleTriggerRegistrationTx,
} from "./automationSessionLifecycleRegistration";

const input = {
    kind: "sessionLifecycle" as const,
    enabled: true,
    event: "parentTurnCompleted" as const,
    scope: { kind: "exactTurn" as const, sourceSessionId: "source-session", sourceTurnId: "source-turn" },
    consumption: "once" as const,
};

function txFixture(params: {
    sourceSession?: { latestTurnId: string | null } | null;
    sourceTurn?: { status: string } | null;
    terminalReceipt?: { id: string } | null;
} = {}): Tx {
    return {
        session: { findFirst: vi.fn(async () => params.sourceSession === undefined ? { latestTurnId: "source-turn" } : params.sourceSession) },
        sessionTurn: { findUnique: vi.fn(async () => params.sourceTurn === undefined ? { status: "in_progress" } : params.sourceTurn) },
        sessionTurnMutationReceipt: { findFirst: vi.fn(async () => params.terminalReceipt ?? null) },
    } as unknown as Tx;
}

async function code(promise: Promise<unknown>) {
    try { await promise; return null; } catch (error) {
        expect(error).toBeInstanceOf(AutomationSessionLifecycleRegistrationValidationError);
        return (error as AutomationSessionLifecycleRegistrationValidationError).code;
    }
}

describe("Session lifecycle trigger registration", () => {
    it("accepts only the same-Account exact current in-progress turn", async () => {
        await expect(validateSessionLifecycleTriggerRegistrationTx({
            tx: txFixture(),
            accountId: "account",
            automationTargetType: "new_session",
            input,
        })).resolves.toEqual({
            sessionLifecycleEvent: "parentTurnCompleted",
            sourceSessionId: "source-session",
            sourceTurnId: "source-turn",
        });
    });

    it.each([
        [{ sourceSession: null }, "sourceSessionUnavailable"],
        [{ sourceSession: { latestTurnId: "newer-turn" } }, "sourceTurnNotCurrent"],
        [{ sourceTurn: null }, "sourceTurnUnavailable"],
        [{ sourceTurn: { status: "completed" } }, "sourceTurnNotInProgress"],
        [{ sourceTurn: { status: "failed" } }, "sourceTurnNotInProgress"],
        [{ sourceTurn: { status: "cancelled" } }, "sourceTurnNotInProgress"],
        [{ terminalReceipt: { id: "terminal" } }, "sourceTurnNotInProgress"],
    ] as const)("rejects stale/unavailable/terminal source truth", async (fixture, expected) => {
        await expect(code(validateSessionLifecycleTriggerRegistrationTx({
            tx: txFixture(fixture),
            accountId: "account",
            automationTargetType: "new_session",
            input,
        }))).resolves.toBe(expected);
    });

    it("requires an existing-Session target distinct from the source", async () => {
        await expect(code(validateSessionLifecycleTriggerRegistrationTx({
            tx: txFixture(),
            accountId: "account",
            automationTargetType: "existing_session",
            input,
        }))).resolves.toBe("executionTargetInequalityUnproven");
        await expect(code(validateSessionLifecycleTriggerRegistrationTx({
            tx: txFixture(),
            accountId: "account",
            automationTargetType: "existing_session",
            automationExistingSessionId: "source-session",
            input,
        }))).resolves.toBe("sourceMatchesExecutionTarget");
        expect(() => validateSessionLifecycleExecutionTargetInequality({
            automationTargetType: "existing_session",
            automationExistingSessionId: "target-session",
            sourceSessionId: "source-session",
        })).not.toThrow();
    });
});
