import { describe, expect, it } from 'vitest';

import type { TurnChangeSet } from '@happier-dev/protocol';

import { buildTurnChangeSetDiffInput } from './buildTurnChangeSetDiffInput';

function makeTurnChangeSet(file: TurnChangeSet['files'][number]): TurnChangeSet {
    return {
        sessionId: 'session_1',
        turnId: 'turn_1',
        seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
        status: 'completed',
        provider: 'codex',
        derivedAt: 1_700_000_000_000,
        files: [file],
    };
}

describe('buildTurnChangeSetDiffInput', () => {
    it('bounds oversized file payloads and keeps metadata for on-demand retrieval', () => {
        const input = buildTurnChangeSetDiffInput({
            turnChangeSet: makeTurnChangeSet({
                filePath: 'src/huge.ts',
                changeKind: 'modified',
                oldText: `${'old\n'.repeat(100)}`,
                newText: `${'new\n'.repeat(100)}`,
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            }),
            protocol: 'codex',
            rawToolName: 'RepositoryCheckpointDiff',
            fileBudgetBytes: 16,
            turnBudgetBytes: 16,
        });

        expect(input).toEqual(expect.objectContaining({
            files: [
                expect.objectContaining({
                    file_path: 'src/huge.ts',
                    change_kind: 'modified',
                    source: 'scm_checkpoint',
                    confidence: 'exact',
                    provider: 'scm:git',
                    truncated: true,
                    stats: expect.objectContaining({
                        oldTextBytes: expect.any(Number),
                        newTextBytes: expect.any(Number),
                    }),
                }),
            ],
            _happier: expect.objectContaining({
                turnDiffTruncatedFileCount: 1,
            }),
        }));

        const file = (input.files as Array<Record<string, unknown>>)[0];
        expect(file.oldText).toBeUndefined();
        expect(file.newText).toBeUndefined();
        expect(file.unified_diff).toEqual(expect.stringContaining('src/huge.ts'));
    });
});
