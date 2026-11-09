import { describe, expect, it } from 'vitest';
import { buildCodeLinesFromUnifiedDiff } from './buildCodeLinesFromUnifiedDiff';
import { expandUnifiedDiffContext } from './expandUnifiedDiffContext';
import { buildReviewCommentDraftFromCodeLine } from '../reviewComments/buildReviewCommentDraftFromCodeLine';
import { WorkspaceAnchorV1Schema } from '@happier-dev/protocol/workspace/anchors/v1';

const expand = (baseText: string, unifiedDiff: string) => expandUnifiedDiffContext({ baseText, unifiedDiff,
    lines: buildCodeLinesFromUnifiedDiff({ unifiedDiff, hideFilePrelude: true }) });

describe('review revision context', () => {
    it('preserves both coordinates around zero-context insertion and deletion hunks', () => {
        const inserted = expand('one\ntwo\nthree\n', '@@ -2,0 +3 @@\n+inserted\n');
        expect(inserted?.filter(line => !line.renderIsHeaderLine).map(line => [line.renderCodeText, line.oldLine, line.newLine]))
            .toEqual([['one', 1, 1], ['two', 2, 2], ['inserted', null, 3], ['three', 3, 4]]);
        const removed = expand('one\ntwo\nthree\n', '@@ -2 +1,0 @@\n-two\n');
        expect(removed?.filter(line => !line.renderIsHeaderLine).map(line => [line.renderCodeText, line.oldLine, line.newLine]))
            .toEqual([['one', 1, 1], ['two', 2, null], ['three', 3, 2]]);
    });

    it('does not borrow a relocated hunk from a different revision', () => {
        expect(expand('shifted\none\ntwo\nthree\n', '@@ -2 +2 @@\n-two\n+changed\n')).toBeNull();
    });

    it('keeps revealed unchanged rows usable by the existing comment anchor owner', () => {
        const lines = expand('one\ntwo\nthree\n', '@@ -2 +2 @@\n-two\n+changed\n')!;
        const line = lines.find(line => line.renderCodeText === 'three')!;
        const draft = buildReviewCommentDraftFromCodeLine({ filePath: 'coast.ts', source: 'diff', lines, targetLine: line,
            body: 'An unchanged-line note', contextRadius: 1, nowMs: 1, id: 'owned-comment' });
        expect(WorkspaceAnchorV1Schema.safeParse(draft.anchor).success).toBe(true);
        expect(draft.anchor).toMatchObject({ kind: 'diffLine', side: 'after', oldLine: 3, newLine: 3 });
        expect(draft.snapshot.selectedLines).toEqual(['three']);
    });
});
