import { parseDiffFromFile } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';

import { pierreTextDiffContents } from './pierreTextDiffContents';

function endOfFileMarkers(oldText: string, newText: string) {
    const { oldContents, newContents } = pierreTextDiffContents(oldText, newText);
    const diff = parseDiffFromFile({ name: 'a.ts', contents: oldContents }, { name: 'a.ts', contents: newContents }, { context: 3 });
    return diff.hunks.map(hunk => [hunk.noEOFCRDeletions, hunk.noEOFCRAdditions]);
}

describe('pierreTextDiffContents', () => {
    it('draws no end-of-file markers for two texts that both end without a newline (an edit snippet)', () => {
        expect(endOfFileMarkers('await db.payments.insert(event)', 'await db.payments.upsert(event)')).toEqual([[false, false]]);
    });

    it('keeps the marker where only one side lost its final newline, which is a real change', () => {
        expect(endOfFileMarkers('a\nb\n', 'a\nc')).toEqual([[false, true]]);
    });
});
