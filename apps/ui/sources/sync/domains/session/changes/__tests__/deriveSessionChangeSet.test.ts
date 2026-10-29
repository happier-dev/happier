import { describe, expect, it } from 'vitest';

import type { TurnChangeSet } from '@happier-dev/protocol';

import { deriveSessionChangeSet } from '../derivation/deriveSessionChangeSet';

const turnOne: TurnChangeSet = {
    sessionId: 'session_1',
    turnId: 'turn_1',
    seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
    status: 'completed',
    provider: 'codex',
    derivedAt: 1,
    files: [{
        filePath: 'src/app.ts',
        changeKind: 'modified',
        oldText: 'a\n',
        newText: 'b\n',
        source: 'provider_native',
        confidence: 'exact',
        provider: 'codex',
    }],
};

const turnTwo: TurnChangeSet = {
    sessionId: 'session_1',
    turnId: 'turn_2',
    seqRange: { startSeqInclusive: 5, endSeqInclusive: 8 },
    status: 'completed',
    provider: 'codex',
    derivedAt: 2,
    files: [{
        filePath: 'src/app.ts',
        changeKind: 'modified',
        oldText: 'b\n',
        newText: 'c\n',
        source: 'provider_native',
        confidence: 'exact',
        provider: 'codex',
    }],
};

describe('deriveSessionChangeSet', () => {
    it('returns null when there are no turns', () => {
        expect(deriveSessionChangeSet({
            sessionId: 'session_1',
            metadata: null,
            turnChangeSets: [],
        })).toBeNull();
    });

    it('applies rollback metadata before aggregating the session change set', () => {
        const result = deriveSessionChangeSet({
            sessionId: 'session_1',
            metadata: {
                sessionRollbackRangesV1: {
                    v: 1,
                    updatedAt: 9,
                    ranges: [{
                        target: { type: 'latest_turn' },
                        startSeqInclusive: 5,
                        endSeqInclusive: 8,
                        rolledBackAt: 10,
                    }],
                },
            },
            turnChangeSets: [turnOne, turnTwo],
        });

        expect(result).toEqual(expect.objectContaining({
            turns: [turnOne],
            rolledBackTurnIds: ['turn_2'],
            files: [
                expect.objectContaining({
                    filePath: 'src/app.ts',
                    newText: 'b\n',
                }),
            ],
        }));
    });

    it('keeps duplicate turn IDs visible when any matching turn survives rollback', () => {
        const rolledBackDuplicate = { ...turnTwo, turnId: turnOne.turnId };
        const result = deriveSessionChangeSet({
            sessionId: 'session_1',
            metadata: {
                sessionRollbackRangesV1: {
                    v: 1,
                    updatedAt: 9,
                    ranges: [{
                        target: { type: 'latest_turn' },
                        startSeqInclusive: 5,
                        endSeqInclusive: 8,
                        rolledBackAt: 10,
                    }],
                },
            },
            turnChangeSets: [rolledBackDuplicate, turnOne],
        });

        expect(result?.turns).toEqual([turnOne]);
        expect(result?.rolledBackTurnIds).toEqual([]);
    });

    it('derives exact visible and rolled-back turns with linear ID reads across 2,000 turns', () => {
        const turnCount = 2_000;
        let turnIdReads = 0;
        const turns = Array.from({ length: turnCount }, (_, index): TurnChangeSet => ({
            sessionId: 'session_1',
            get turnId() {
                turnIdReads += 1;
                return `turn_${index}`;
            },
            seqRange: { startSeqInclusive: index + 1, endSeqInclusive: index + 1 },
            status: 'completed',
            provider: 'codex',
            derivedAt: index,
            files: [],
        }));
        const result = deriveSessionChangeSet({
            sessionId: 'session_1',
            metadata: {
                sessionRollbackRangesV1: {
                    v: 1,
                    updatedAt: 2_001,
                    ranges: [{
                        target: { type: 'latest_turn' },
                        startSeqInclusive: 501,
                        endSeqInclusive: 1_500,
                        rolledBackAt: 2_002,
                    }],
                },
            },
            turnChangeSets: [...turns].reverse(),
        });
        // Snapshot before assertions inspect the counted getters themselves.
        const derivationIdReads = turnIdReads;

        expect(result).toEqual({
            sessionId: 'session_1',
            turns: [...turns.slice(0, 500), ...turns.slice(1_500)],
            files: [],
            rolledBackTurnIds: Array.from({ length: 1_000 }, (_, index) => `turn_${1_499 - index}`),
            confidenceSummary: {
                source: 'unavailable',
                confidence: 'unavailable',
                attribution: { confidence: 'unknown', reason: 'unavailable' },
                checkpointOverlap: 'unknown',
            },
        });
        // One membership build plus one partition read and one read per excluded ID is 2N.
        // Empty files and distinct sequence ranges isolate membership from file merging/sort ties.
        console.info('deriveSessionChangeSet ID-read cost', { turnCount, derivationIdReads });
        expect(derivationIdReads).toBeLessThanOrEqual(2 * turnCount);
    });
});
