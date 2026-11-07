import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionTurnMutationDecisionV1, SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';

type Turn = Readonly<{ status: string; startedAt: bigint | number; updatedAt: bigint | number }>;
type Refusal = Readonly<{
    ok: false;
    reason: 'terminal-turn' | 'no-current-turn' | 'stale-in-progress';
    decision: SessionTurnMutationDecisionV1;
}>;

function isTerminal(status: string): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed' || status === 'waiting';
}

export function resolveSessionTurnTerminalStatus(mutation: SessionTurnMutationV1): PrimaryTurnStatusV1 | null {
    if (mutation.action === 'wait') return 'waiting';
    if (mutation.action === 'complete') return 'completed';
    if (mutation.action === 'fail') return 'failed';
    if (mutation.action === 'cancel' || mutation.action === 'end_session') return 'cancelled';
    return null;
}

/** One transition decision over the captured turn; the caller owns its atomic receipt/write. */
export async function decideSessionTurnMutation(params: Readonly<{
    mutation: SessionTurnMutationV1;
    currentTurn: Turn | null;
    targetTurnId: string;
    requestedTurnId: string | undefined;
    latestTurnId: string | null;
    terminalStatus: PrimaryTurnStatusV1 | null;
    loadLatestTurnStatus: (turnId: string) => Promise<string | null>;
}>): Promise<Refusal | Readonly<{ ok: true; updatesRollbackFacet: boolean }>> {
    const { mutation, currentTurn, targetTurnId, requestedTurnId, latestTurnId, terminalStatus } = params;
    const terminal = (): Refusal => ({ ok: false, reason: 'terminal-turn', decision: 'stale-terminal' });
    if (mutation.action === 'begin' && currentTurn && isTerminal(currentTurn.status)) return terminal();
    if (mutation.action !== 'begin' && !currentTurn) {
        return { ok: false, reason: 'no-current-turn', decision: 'missing-turn' };
    }
    // A delayed exit cannot cancel a replacement turn begun after that exit.
    if (mutation.action === 'end_session' && currentTurn?.status === 'in_progress') {
        const startedAt = typeof currentTurn.startedAt === 'bigint'
            ? Number(currentTurn.startedAt) : currentTurn.startedAt;
        if (Number.isFinite(startedAt) && startedAt > mutation.observedAt) return terminal();
    }
    const updatesRollbackFacet = mutation.action === 'mark_rollback_eligible' || mutation.action === 'mark_rolled_back';
    const explicitlyStopsWaitingTurn = currentTurn?.status === 'waiting'
        && mutation.action === 'cancel' && mutation.reason === 'explicit_stop';
    // Late anchors may annotate a cancelled turn without reopening its lifecycle.
    const appendsCancelledTurnAnchors = currentTurn?.status === 'cancelled' && mutation.action === 'append_transcript_anchors';
    if (currentTurn && isTerminal(currentTurn.status)
        && !updatesRollbackFacet && !explicitlyStopsWaitingTurn && !appendsCancelledTurnAnchors) {
        return { ...terminal(), decision: mutation.action === 'end_session'
            && requestedTurnId === targetTurnId && latestTurnId === targetTurnId
                ? 'duplicate-terminal' : 'stale-terminal' };
    }
    if (terminalStatus && requestedTurnId && latestTurnId && requestedTurnId !== latestTurnId
        && await params.loadLatestTurnStatus(latestTurnId) === 'in_progress') return terminal();
    if (mutation.action === 'touch_active' && latestTurnId && targetTurnId !== latestTurnId) return terminal();
    if (updatesRollbackFacet && currentTurn?.status !== 'completed') return terminal();
    if (mutation.action === 'touch_active' && currentTurn
        && BigInt(Math.max(0, Math.floor(mutation.observedAt))) <= currentTurn.updatedAt) {
        return { ok: false, reason: 'stale-in-progress', decision: 'stale-in-progress' };
    }
    return { ok: true, updatesRollbackFacet };
}
