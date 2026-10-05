import { describe, expect, it } from 'vitest';

import { readTurnChangesFromDiffTool } from './readTurnChangesFromDiffTool';

const TURN_META = {
    sessionChangeScope: 'turn',
    turnId: 'turn-4',
    sessionId: 'session-1',
    provider: 'claude',
    source: 'canonical_diff_tool',
    confidence: 'exact',
    turnStatus: 'completed',
    seqRange: { startSeqInclusive: 10, endSeqInclusive: 20 },
} as const;

describe('readTurnChangesFromDiffTool', () => {
    it('reads the turn-end recap as that turn’s files with their line counts, one row per path', () => {
        const result = readTurnChangesFromDiffTool({
            name: 'Diff',
            input: {
                _happier: TURN_META,
                files: [
                    { file_path: 'src/a.ts', change_kind: 'modified', unified_diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-x\n+y\n+z\n' },
                    { file_path: 'src/new.ts', change_kind: 'added', stats: { addedLines: 21, removedLines: 0 } },
                    { file_path: 'img.png', change_kind: 'modified', binary: true },
                    { file_path: 'src/a.ts', change_kind: 'modified', stats: { addedLines: 4, removedLines: 2 } },
                ],
            },
        });
        expect(result?.turnId).toBe('turn-4');
        expect(result?.files.map((file) => [file.fullPath, file.status, file.linesAdded, file.linesRemoved, file.isComplete])).toEqual([
            ['src/a.ts', 'modified', 4, 2, undefined],
            ['src/new.ts', 'added', 21, 0, undefined],
            // No diff and no statistics: the counts are unknown, not zero.
            ['img.png', 'modified', 0, 0, false],
        ]);
    });

    it('is not a turn’s changes for an ordinary diff or another tool', () => {
        expect(readTurnChangesFromDiffTool({ name: 'Diff', input: { unified_diff: '--- a\n+++ b\n' } })).toBeNull();
        expect(readTurnChangesFromDiffTool({ name: 'Patch', input: { _happier: TURN_META, files: [] } })).toBeNull();
    });
});
