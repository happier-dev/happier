import { PrimaryTurnStatusV1Schema, sanitizeSessionRuntimeIssueV1, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SessionTurnFactsV1Schema, type SessionTurnFactsV1, SessionTurnMutationActionV1Schema, SessionTurnMutationDecisionV1Schema, SessionTurnRollbackStateV1Schema, SessionTurnTranscriptAnchorsV1Schema, type SessionTurnMutationReceiptV1, type SessionTurnTranscriptAnchorsV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { type SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { AutomationSessionLifecycleFactsSchema } from '@happier-dev/protocol/automations/automationSessionLifecycle';

type StoredBigInt = bigint | number | null | undefined;

export type SessionTurnStoredRow = Readonly<{
    turnId: string;
    agentId?: string | null;
    agentTurnId?: string | null;
    status: string;
    initiator?: string;
    workDepth?: number;
    workflowInvocationJson?: string | null;
    automationLifecycleFactsJson?: string | null;
    startedAt: StoredBigInt;
    updatedAt: StoredBigInt;
    terminalAt?: StoredBigInt;
    lastRuntimeIssueJson?: string | null;
    transcriptAnchorsJson?: string | null;
    /**
     * Private query projection used by the canonical external transcript
     * reader to locate a turn without parsing every SessionTurn row.
     */
    transcriptAnchorProjectionVersion?: number | null;
    transcriptAnchorMinSeq?: number | null;
    transcriptAnchorMaxSeq?: number | null;
    rollbackState?: string | null;
    rollbackReason?: string | null;
    agentRollbackOrdinal?: number | null;
    rollbackUpdatedAt?: StoredBigInt;
    lastMutationId?: string | null;
}>;

export type SessionTurnMutationReceiptStoredRow = Readonly<{
    sessionId: string;
    mutationId: string;
    turnId?: string | null;
    action: string;
    decision: string;
    observedAt: StoredBigInt;
    appliedAt: StoredBigInt;
}>;

function readStoredNumber(value: StoredBigInt): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    return null;
}

function parseJsonObject(value: string | null | undefined): unknown {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export function parseStoredSessionRuntimeIssue(value: string | null | undefined): SessionRuntimeIssueV1 | null {
    return sanitizeSessionRuntimeIssueV1(parseJsonObject(value));
}

export function parseStoredSessionTurnTranscriptAnchors(value: string | null | undefined): SessionTurnTranscriptAnchorsV1 | undefined {
    const parsed = SessionTurnTranscriptAnchorsV1Schema.safeParse(parseJsonObject(value));
    return parsed.success ? parsed.data : undefined;
}

/** Immutable host facts are not inferred from mutable Session activity. */
export function parseStoredSessionTurnFacts(row: Readonly<{
    initiator: string;
    workDepth: number;
    workflowInvocationJson: string | null;
}>): SessionTurnFactsV1 {
    return SessionTurnFactsV1Schema.parse({
        initiator: row.initiator,
        workDepth: row.workDepth,
        ...(row.workflowInvocationJson !== null
            ? { workflowInvocation: JSON.parse(row.workflowInvocationJson) }
            : {}),
    });
}

export function parseStoredSessionTurn(row: SessionTurnStoredRow): SessionTurnV1 | null {
    const status = PrimaryTurnStatusV1Schema.safeParse(row.status);
    const startedAt = readStoredNumber(row.startedAt);
    const updatedAt = readStoredNumber(row.updatedAt);
    if (!status.success || startedAt === null || updatedAt === null) return null;

    const terminalAt = readStoredNumber(row.terminalAt);
    const rollbackUpdatedAt = readStoredNumber(row.rollbackUpdatedAt);
    const rollbackState = SessionTurnRollbackStateV1Schema.safeParse(row.rollbackState);
    const transcriptAnchors = parseStoredSessionTurnTranscriptAnchors(row.transcriptAnchorsJson);
    const lastRuntimeIssue = parseStoredSessionRuntimeIssue(row.lastRuntimeIssueJson);
    const automationLifecycleFacts = AutomationSessionLifecycleFactsSchema.safeParse(parseJsonObject(row.automationLifecycleFactsJson));

    return {
        turnId: row.turnId,
        ...(row.initiator !== undefined && row.workDepth !== undefined
            ? parseStoredSessionTurnFacts({ initiator: row.initiator, workDepth: row.workDepth,
                workflowInvocationJson: row.workflowInvocationJson ?? null })
            : {}),
        ...(row.agentId ? { agentId: row.agentId } : {}),
        ...(row.agentTurnId ? { agentTurnId: row.agentTurnId } : {}),
        status: status.data,
        ...(automationLifecycleFacts.success ? { automationLifecycleFacts: automationLifecycleFacts.data } : {}),
        startedAt,
        updatedAt,
        ...(terminalAt !== null ? { terminalAt } : {}),
        ...(row.lastRuntimeIssueJson !== undefined ? { lastRuntimeIssue } : {}),
        ...(transcriptAnchors ? { transcriptAnchors } : {}),
        ...(rollbackState.success && rollbackUpdatedAt !== null
            ? {
                rollback: {
                    state: rollbackState.data,
                    ...(row.rollbackReason ? { reason: row.rollbackReason } : {}),
                    ...(typeof row.agentRollbackOrdinal === "number" ? { agentRollbackOrdinal: row.agentRollbackOrdinal } : {}),
                    ...(transcriptAnchors?.providerCheckpoint !== undefined
                        ? { providerCheckpoint: transcriptAnchors.providerCheckpoint }
                        : {}),
                    updatedAt: rollbackUpdatedAt,
                },
            }
            : {}),
        ...(row.lastMutationId ? { lastMutationId: row.lastMutationId } : {}),
    };
}

export function parseStoredSessionTurns(rows: readonly SessionTurnStoredRow[]): readonly SessionTurnV1[] {
    return rows.flatMap((row) => {
        const parsed = parseStoredSessionTurn(row);
        return parsed ? [parsed] : [];
    });
}

export function parseStoredSessionTurnMutationReceipt(row: SessionTurnMutationReceiptStoredRow): SessionTurnMutationReceiptV1 | null {
    const observedAt = readStoredNumber(row.observedAt);
    const appliedAt = readStoredNumber(row.appliedAt);
    const action = SessionTurnMutationActionV1Schema.safeParse(row.action);
    const decision = SessionTurnMutationDecisionV1Schema.safeParse(row.decision);
    if (observedAt === null || appliedAt === null || !action.success || !decision.success) return null;
    return {
        v: 1,
        sessionId: row.sessionId,
        mutationId: row.mutationId,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        action: action.data,
        decision: decision.data,
        observedAt,
        appliedAt,
    };
}
