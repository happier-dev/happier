import type { Session } from '@/sync/domains/state/storageTypes';

export type ExactTurnAutomationPrefill = Readonly<{
    sourceSessionId: string;
    sourceTurnId: string;
    sourceServerId: string;
}>;

function nonEmpty(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

/** Exact observed parent-turn identity; this never infers or retargets. */
export function readExactActiveParentTurn(
    session: Pick<Session, 'id' | 'serverId' | 'latestTurnId' | 'latestTurnStatus'> | null | undefined,
): ExactTurnAutomationPrefill | null {
    if (!session || session.latestTurnStatus !== 'in_progress') return null;
    const sourceSessionId = nonEmpty(session.id);
    const sourceTurnId = nonEmpty(session.latestTurnId);
    const sourceServerId = nonEmpty(session.serverId);
    return sourceSessionId && sourceTurnId && sourceServerId
        ? Object.freeze({ sourceSessionId, sourceTurnId, sourceServerId })
        : null;
}

export function parseExactTurnAutomationPrefill(input: Readonly<{
    sourceSessionId?: unknown;
    sourceTurnId?: unknown;
    sourceServerId?: unknown;
}>): ExactTurnAutomationPrefill | null {
    const sourceSessionId = nonEmpty(input.sourceSessionId);
    const sourceTurnId = nonEmpty(input.sourceTurnId);
    const sourceServerId = nonEmpty(input.sourceServerId);
    return sourceSessionId && sourceTurnId && sourceServerId
        ? Object.freeze({ sourceSessionId, sourceTurnId, sourceServerId })
        : null;
}

export function areExactTurnAutomationPrefillsEqual(
    left: ExactTurnAutomationPrefill | null | undefined,
    right: ExactTurnAutomationPrefill | null | undefined,
): boolean {
    return left?.sourceSessionId === right?.sourceSessionId
        && left?.sourceTurnId === right?.sourceTurnId
        && left?.sourceServerId === right?.sourceServerId;
}

export function buildExactTurnAutomationRouteParams(prefill: ExactTurnAutomationPrefill) {
    return {
        sourceSessionId: prefill.sourceSessionId,
        sourceTurnId: prefill.sourceTurnId,
        sourceServerId: prefill.sourceServerId,
    } as const;
}
