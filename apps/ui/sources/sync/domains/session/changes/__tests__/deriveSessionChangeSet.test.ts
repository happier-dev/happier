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
            rolledBackTurnIds: ['turn_2'],
            files: [
                expect.objectContaining({
                    filePath: 'src/app.ts',
                    newText: 'b\n',
                }),
            ],
        }));
    });
});
