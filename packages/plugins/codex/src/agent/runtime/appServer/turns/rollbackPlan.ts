import type { SessionRollbackTarget, SessionTurnV1 } from '@happier-dev/protocol';

export type CodexAppServerRollbackPlan = Readonly<{
    numTurns: number;
    targetUserMessageSeq: number;
    affectedTurnIds: readonly string[];
    range: Readonly<{
        startSeqInclusive: number;
        endSeqInclusive: number;
    }>;
}>;

export function resolveCodexAppServerRollbackPlanFromSessionTurns(params: Readonly<{
    target: SessionRollbackTarget;
    turns: readonly SessionTurnV1[];
}>): CodexAppServerRollbackPlan | null {
    const completedTurns = listRollbackEligibleTurns(params.turns);
    if (completedTurns.length === 0) return null;

    if (params.target.type === 'latest_turn') {
        const latest = completedTurns[completedTurns.length - 1];
        if (!latest) return null;
        return {
            numTurns: 1,
            targetUserMessageSeq: latest.startUserMessageSeq,
            affectedTurnIds: [latest.turn.turnId],
            range: {
                startSeqInclusive: latest.startSeqInclusive,
                endSeqInclusive: latest.endSeqInclusive,
            },
        };
    }

    if (params.target.type !== 'before_user_message') return null;
    const targetUserMessageSeq = params.target.userMessageSeq;
    const targetIndex = completedTurns.findIndex(
        (turn) => turn.startUserMessageSeq === targetUserMessageSeq,
    );
    if (targetIndex < 0) return null;
    const target = completedTurns[targetIndex];
    const latest = completedTurns[completedTurns.length - 1];
    if (!target || !latest) return null;
    const affectedTurns = completedTurns.slice(targetIndex);

    return {
        numTurns: affectedTurns.length,
        targetUserMessageSeq: target.startUserMessageSeq,
        affectedTurnIds: affectedTurns.map((turn) => turn.turn.turnId),
        range: {
            startSeqInclusive: target.startSeqInclusive,
            endSeqInclusive: latest.endSeqInclusive,
        },
    };
}

type RollbackEligibleTurn = Readonly<{
    turn: SessionTurnV1;
    startUserMessageSeq: number;
    startSeqInclusive: number;
    endSeqInclusive: number;
}>;

function readNonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readRollbackEligibleTurn(turn: SessionTurnV1): RollbackEligibleTurn | null {
    if (turn.status !== 'completed' || turn.rollback?.state !== 'eligible') return null;
    const anchors = turn.transcriptAnchors;
    const startUserMessageSeq = readNonNegativeInteger(anchors?.startUserMessageSeq);
    const endSeqInclusive = readNonNegativeInteger(anchors?.endSeqInclusive);
    if (startUserMessageSeq === null || endSeqInclusive === null) return null;
    return {
        turn,
        startUserMessageSeq,
        startSeqInclusive: readNonNegativeInteger(anchors?.startSeqInclusive) ?? startUserMessageSeq,
        endSeqInclusive,
    };
}

function listRollbackEligibleTurns(turns: readonly SessionTurnV1[]): RollbackEligibleTurn[] {
    return turns.flatMap((turn) => {
        const eligible = readRollbackEligibleTurn(turn);
        return eligible ? [eligible] : [];
    });
}
