import { describe, expect, it } from 'vitest';

import type { TurnChangeSet } from './types.js';
import {
    buildSessionRollbackRangesV1,
    excludeRolledBackTurns,
    readSessionRollbackRangesV1FromMetadata,
    SessionRollbackRangeV1Schema,
    SessionRollbackRangesV1Schema,
} from './rollbacks.js';
import { mergeTurnChangeSets } from './mergeTurnChangeSets.js';

function buildTurn(params: Readonly<{
    turnId: string;
    seqRange: { startSeqInclusive: number; endSeqInclusive: number };
    files: TurnChangeSet['files'];
}>): TurnChangeSet {
    return {
        sessionId: 'session_1',
        turnId: params.turnId,
        seqRange: params.seqRange,
        status: 'completed',
        files: params.files,
        provider: 'codex',
        derivedAt: 1_700_000_000_000,
    };
}

describe('session change-set merge and rollback helpers', () => {
    it('parses rollback range schemas and round-trips metadata envelopes', () => {
        const range = SessionRollbackRangeV1Schema.parse({
            target: { type: 'latest_turn' },
            startSeqInclusive: 7,
            endSeqInclusive: 11,
            rolledBackAt: 122,
        });

        const parsed = SessionRollbackRangesV1Schema.parse(
            buildSessionRollbackRangesV1({
                updatedAt: 123,
                ranges: [range],
            }),
        );

        expect(parsed).toMatchObject({
            v: 1,
            updatedAt: 123,
            ranges: [
                {
                    target: { type: 'latest_turn' },
                    startSeqInclusive: 7,
                    endSeqInclusive: 11,
                    rolledBackAt: 122,
                },
            ],
        });
        expect(
            readSessionRollbackRangesV1FromMetadata({
                sessionRollbackRangesV1: parsed,
            }),
        ).toMatchObject({
            ranges: [expect.objectContaining({ startSeqInclusive: 7, endSeqInclusive: 11 })],
        });
    });

    it('aggregates multiple turns into the latest file state while preserving file history', () => {
        const first = buildTurn({
            turnId: 'turn_1',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
            files: [{
                filePath: 'src/app.ts',
                changeKind: 'modified',
                oldText: 'a\n',
                newText: 'b\n',
                source: 'provider_native',
                confidence: 'exact',
                provider: 'codex',
            }],
        });
        const second = buildTurn({
            turnId: 'turn_2',
            seqRange: { startSeqInclusive: 5, endSeqInclusive: 8 },
            files: [{
                filePath: 'src/app.ts',
                changeKind: 'modified',
                oldText: 'b\n',
                newText: 'c\n',
                source: 'provider_native',
                confidence: 'exact',
                provider: 'codex',
            }, {
                filePath: 'src/new.ts',
                changeKind: 'added',
                newText: 'hello\n',
                source: 'provider_native',
                confidence: 'exact',
                provider: 'codex',
            }],
        });

        const aggregated = mergeTurnChangeSets({
            sessionId: 'session_1',
            turns: [first, second],
        });

        expect(aggregated.turns.map((turn) => turn.turnId)).toEqual(['turn_1', 'turn_2']);
        expect(aggregated.files).toEqual([
            expect.objectContaining({
                filePath: 'src/app.ts',
                changeKind: 'modified',
                oldText: 'a\n',
                newText: 'c\n',
                turns: ['turn_1', 'turn_2'],
            }),
            expect.objectContaining({
                filePath: 'src/new.ts',
                changeKind: 'added',
                newText: 'hello\n',
                turns: ['turn_2'],
            }),
        ]);
        expect(aggregated.confidenceSummary).toEqual({
            source: 'provider_native',
            confidence: 'exact',
        });
    });

    it('drops rolled-back turns before aggregating session changes', () => {
        const first = buildTurn({
            turnId: 'turn_1',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
            files: [{
                filePath: 'src/app.ts',
                changeKind: 'modified',
                oldText: 'a\n',
                newText: 'b\n',
                source: 'provider_native',
                confidence: 'exact',
                provider: 'codex',
            }],
        });
        const second = buildTurn({
            turnId: 'turn_2',
            seqRange: { startSeqInclusive: 4, endSeqInclusive: 8 },
            files: [{
                filePath: 'src/app.ts',
                changeKind: 'modified',
                oldText: 'b\n',
                newText: 'c\n',
                source: 'provider_native',
                confidence: 'exact',
                provider: 'codex',
            }],
        });

        const rollbackRanges = [
            {
                target: { type: 'latest_turn' },
                startSeqInclusive: 4,
                endSeqInclusive: 8,
                rolledBackAt: 1_700_000_000_001,
            },
        ] as const;

        const visibleTurns = excludeRolledBackTurns({
            turns: [first, second],
            rollbackRanges,
        });

        const aggregated = mergeTurnChangeSets({
            sessionId: 'session_1',
            turns: visibleTurns,
            rolledBackTurnIds: ['turn_2'],
        });

        expect(visibleTurns.map((turn) => turn.turnId)).toEqual(['turn_1']);
        expect(aggregated.rolledBackTurnIds).toEqual(['turn_2']);
        expect(aggregated.files).toEqual([
            expect.objectContaining({
                filePath: 'src/app.ts',
                oldText: 'a\n',
                newText: 'b\n',
                turns: ['turn_1'],
            }),
        ]);
    });
});
