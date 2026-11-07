import { describe, expect, it } from 'vitest';
import { buildChangedFilesReviewFileIndex } from './changedFilesReviewFileIndex';

describe('Review inventory order and initial folding', () => {
    it('keeps stable source order, respects captured overrides, and refreshes order and folding on replacement', () => {
        const files = [{ fullPath: 'yarn.lock' }, { fullPath: 'src/a.ts' }, { fullPath: 'src/b.ts' }];
        const inventory = buildChangedFilesReviewFileIndex(files);
        expect(inventory.orderedFileIndices.map(index => inventory.files[index]!.fullPath))
            .toEqual(['src/a.ts', 'src/b.ts', 'yarn.lock']);
        expect(inventory.defaultCollapsedPaths).toEqual(['yarn.lock']);
        expect(inventory.indexById.get('src/b.ts')).toBe(2);
        const captured = buildChangedFilesReviewFileIndex(files, [
            { path: 'yarn.lock', lockfile: false }, { path: 'src/a.ts', generated: true },
        ]);
        expect(captured.orderedFileIndices.map(index => captured.files[index]!.fullPath))
            .toEqual(['yarn.lock', 'src/b.ts', 'src/a.ts']);
        expect(captured.defaultCollapsedPaths).toEqual(['yarn.lock']);
        const changed = buildChangedFilesReviewFileIndex([{ fullPath: 'src/now-source.ts' }, ...files.slice(1)]);
        expect(changed.orderedFileIndices).toEqual([0, 1, 2]);
        expect(changed.defaultCollapsedPaths).toEqual([]);
        expect(changed.indexById.has('yarn.lock')).toBe(false);
        expect(changed.items[0]?.id).toBe('src/now-source.ts');
        expect(buildChangedFilesReviewFileIndex([]).orderedFileIndices).toEqual([]);
    });
});
