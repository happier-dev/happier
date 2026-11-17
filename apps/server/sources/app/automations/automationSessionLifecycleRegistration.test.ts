import { describe, expect, it, vi } from "vitest";
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { Tx } from "@/storage/inTx";
import {
    AutomationSessionLifecycleRegistrationValidationError,
    validateSessionLifecycleExecutionTargetInequality,
    validateSessionLifecycleTriggerRegistrationTx as register,
} from "./automationSessionLifecycleRegistration";

const serverIdentityId = 'srv_00000000000000000000000000000000';
const exact = { subjectKind: 'session' as const, subjectKey: automationSubjectKeyV1({
    kind: 'session', serverId: serverIdentityId, sessionId: 'source-session',
}) };
const validateSessionLifecycleTriggerRegistrationTx = (params: Omit<Parameters<typeof register>[0], 'serverIdentityId'>) =>
    register({ ...params, serverIdentityId });
const input = {
    kind: "sessionLifecycle" as const,
    enabled: true,
    sourceSessionId: "source-session",
    ...exact,
    events: ["parentTurnCompleted"] as ["parentTurnCompleted"],
    policy: { kind: "currentTurn" as const, sourceTurnId: "source-turn" },
};

function txFixture(params: {
    sourceSession?: { latestTurnId: string | null; createdAt?: Date } | null;
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
    it("admits Session-start only with the exact newborn row's transaction context", async () => {
        const createdAt = new Date("2026-10-05T00:00:00.000Z");
        await expect(validateSessionLifecycleTriggerRegistrationTx({
            tx: txFixture({ sourceSession: { latestTurnId: null, createdAt } }),
            accountId: "account", automationTargetType: null,
            newbornSession: { id: "source-session", accountId: "account", createdAt },
            input: { kind: "sessionLifecycle", enabled: true, ...exact,
                events: ["sessionStarted"], policy: { kind: "everyMatch" } },
        })).resolves.toMatchObject({ ...exact, events: ["sessionStarted"] });
    });

    it("refuses a Session-start registration outside the birth transaction", async () => {
        await expect(code(validateSessionLifecycleTriggerRegistrationTx({
            tx: txFixture(), accountId: "account", automationTargetType: null,
            input: { kind: "sessionLifecycle", enabled: true, ...exact,
                events: ["sessionStarted"], policy: { kind: "everyMatch" } },
        }))).resolves.toBe("session_already_started");
    });

    it('accepts a future broad Session-start selection without a newborn or source read', async () => {
        const tx = txFixture({ sourceSession: null });
        await expect(validateSessionLifecycleTriggerRegistrationTx({
            tx, accountId: 'account', automationTargetType: 'existing_session',
            input: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'everyMatch' } },
        })).resolves.toMatchObject({ events: ['sessionStarted'], policy: { kind: 'everyMatch' } });
        expect(tx.session.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a forged exact-turn digest witness', async () => {
        await expect(code(validateSessionLifecycleTriggerRegistrationTx({
            tx: txFixture(), accountId: 'account', automationTargetType: null,
            input: { ...input, subjectKey: automationSubjectKeyV1({
                kind: 'session', serverId: serverIdentityId, sessionId: 'different-session',
            }) },
        }))).resolves.toBe('session_trigger_current_turn_requires_session');
    });

    it("accepts only the same-Account exact current in-progress turn", async () => {
        await expect(validateSessionLifecycleTriggerRegistrationTx({
            tx: txFixture(),
            accountId: "account",
            automationTargetType: "new_session",
            input,
        })).resolves.toEqual({
            kind: "sessionLifecycle",
            sourceSessionId: "source-session",
            ...exact,
            events: ["parentTurnCompleted"],
            policy: { kind: "currentTurn", sourceTurnId: "source-turn" },
        });
    });

    it("arms future policies from the same-Account Session without requiring an active turn", async () => {
        const tx = txFixture({ sourceSession: { latestTurnId: null } });
        await expect(validateSessionLifecycleTriggerRegistrationTx({
            tx,
            accountId: "account",
            automationTargetType: "new_session",
            input: {
                kind: "sessionLifecycle",
                enabled: true,
                ...exact,
                events: ["parentTurnFailed", "userActionRequired"],
                policy: { kind: "everyMatch" },
            },
        })).resolves.toMatchObject({
            ...exact,
            policy: { kind: "everyMatch" },
        });
        expect(tx.sessionTurn.findUnique).not.toHaveBeenCalled();
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
            serverIdentityId, input,
        })).not.toThrow();
    });
});
