import {
    PrimaryTurnStatusV1Schema,
    SessionRuntimeIssueV1Schema,
    SessionTurnMutationActionV1Schema,
    SessionTurnMutationDecisionV1Schema,
    SessionTurnRollbackStateV1Schema,
    SessionTurnTranscriptAnchorsV1Schema,
    type SessionRuntimeIssueV1,
    type SessionTurnMutationReceiptV1,
    type SessionTurnTranscriptAnchorsV1,
    type SessionTurnV1,
} from "@happier-dev/protocol";

type StoredBigInt = bigint | number | null | undefined;

export type SessionTurnStoredRow = Readonly<{
    turnId: string;
    provider?: string | null;
    providerTurnId?: string | null;
    status: string;
    startedAt: StoredBigInt;
    updatedAt: StoredBigInt;
    terminalAt?: StoredBigInt;
    lastRuntimeIssueJson?: string | null;
    transcriptAnchorsJson?: string | null;
    rollbackState?: string | null;
    rollbackReason?: string | null;
    providerRollbackOrdinal?: number | null;
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
    const parsed = SessionRuntimeIssueV1Schema.safeParse(parseJsonObject(value));
    return parsed.success ? parsed.data : null;
}

export function parseStoredSessionTurnTranscriptAnchors(value: string | null | undefined): SessionTurnTranscriptAnchorsV1 | undefined {
    const parsed = SessionTurnTranscriptAnchorsV1Schema.safeParse(parseJsonObject(value));
    return parsed.success ? parsed.data : undefined;
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

    return {
        turnId: row.turnId,
        ...(row.provider ? { provider: row.provider } : {}),
        ...(row.providerTurnId ? { providerTurnId: row.providerTurnId } : {}),
        status: status.data,
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
                    ...(typeof row.providerRollbackOrdinal === "number" ? { providerRollbackOrdinal: row.providerRollbackOrdinal } : {}),
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
