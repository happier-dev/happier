import { describe, expect, it } from 'vitest';

import type { CodexAppServerSessionTurn } from '../core';
import { resolveCodexAppServerRollbackPlanFromSessionTurns } from './rollbackPlan';

function createTurn(
    overrides: Partial<CodexAppServerSessionTurn> & Pick<CodexAppServerSessionTurn, 'turnId'>,
): CodexAppServerSessionTurn {
    return {
        status: 'completed',
        startedAt: 100,
        updatedAt: 200,
        terminalAt: 200,
        transcriptAnchors: {
            startUserMessageSeq: 1,
            userMessageSeqs: [1],
            startSeqInclusive: 1,
            endSeqInclusive: 2,
        },
        rollback: {
            state: 'eligible',
            updatedAt: 200,
        },
        ...overrides,
    };
}

describe('resolveCodexAppServerRollbackPlanFromSessionTurns', () => {
    it('uses eligible SessionTurn rollback facets instead of steer user rows', () => {
        const plan = resolveCodexAppServerRollbackPlanFromSessionTurns({
            target: { type: 'before_user_message', userMessageSeq: 11 },
            turns: [
                createTurn({
                    turnId: 'session-turn-1',
                    agentTurnId: 'provider-turn-1',
                    transcriptAnchors: {
                        startUserMessageSeq: 11,
                        userMessageSeqs: [11, 15],
                        startSeqInclusive: 10,
                        endSeqInclusive: 20,
                    },
                }),
            ],
        });

        expect(resolveCodexAppServerRollbackPlanFromSessionTurns({
            target: { type: 'before_user_message', userMessageSeq: 15 },
            turns: [
                createTurn({
                    turnId: 'session-turn-1',
                    transcriptAnchors: {
                        startUserMessageSeq: 11,
                        userMessageSeqs: [11, 15],
                        startSeqInclusive: 10,
                        endSeqInclusive: 20,
                    },
                }),
            ],
        })).toBeNull();
        expect(plan).toEqual({
            numTurns: 1,
            targetUserMessageSeq: 11,
            affectedTurnIds: ['session-turn-1'],
            range: {
                startSeqInclusive: 10,
                endSeqInclusive: 20,
            },
        });
    });

    it('counts only active eligible completed turns from the rollback target through latest', () => {
        expect(resolveCodexAppServerRollbackPlanFromSessionTurns({
            target: { type: 'before_user_message', userMessageSeq: 30 },
            turns: [
                createTurn({
                    turnId: 'already-rolled-back',
                    transcriptAnchors: {
                        startUserMessageSeq: 10,
                        startSeqInclusive: 10,
                        endSeqInclusive: 12,
                    },
                    rollback: { state: 'rolled_back', updatedAt: 300 },
                }),
                createTurn({
                    turnId: 'target-turn',
                    transcriptAnchors: {
                        startUserMessageSeq: 30,
                        startSeqInclusive: 29,
                        endSeqInclusive: 35,
                    },
                }),
                createTurn({
                    turnId: 'latest-turn',
                    transcriptAnchors: {
                        startUserMessageSeq: 40,
                        startSeqInclusive: 40,
                        endSeqInclusive: 48,
                    },
                }),
            ],
        })).toEqual({
            numTurns: 2,
            targetUserMessageSeq: 30,
            affectedTurnIds: ['target-turn', 'latest-turn'],
            range: {
                startSeqInclusive: 29,
                endSeqInclusive: 48,
            },
        });
    });
});
