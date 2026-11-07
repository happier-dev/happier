import { describe, expect, it } from 'vitest';
import { buildHunkReviewNavigation, buildHunkReviewSummary, buildLiveReviewFiles, getLiveReviewBase, moveHunkReviewCursor as movePreparedCursor, resolveHunkReviewUnit, type HunkReviewCursor, type HunkReviewFile } from './hunkReviewModel';
import { buildChangedFilesReviewFileIndex } from '../changedFilesReviewFileIndex';

function prepare(files: readonly HunkReviewFile[], marked: ReadonlySet<string>) {
    return buildHunkReviewNavigation(files, marked, buildChangedFilesReviewFileIndex(files.map(file => ({
        fullPath: file.path, generated: file.generated, lockfile: file.lockfile,
    }))));
}
function moveHunkReviewCursor(files: readonly HunkReviewFile[], cursor: HunkReviewCursor | null,
    direction: 1 | -1, marked: ReadonlySet<string>, fileOnly = false) {
    return movePreparedCursor(prepare(files, marked), cursor, direction, fileOnly);
}

const files: readonly HunkReviewFile[] = [
    { path: 'a.ts', keys: ['a1', 'a2'] },
    { path: 'b.ts', keys: ['b1'] },
    { path: 'yarn.lock', keys: ['l1'], lockfile: true },
    { path: 'c.ts', keys: ['c1'] },
];

describe('review cursor and counter', () => {
    it('uses GitHub Viewed for file completion and next-file navigation while Keep remains per content key', () => {
        const marked = new Set(['a1', 'a2']);
        const viewed = new Set(['b.ts']);
        const navigation = buildHunkReviewNavigation(files, marked, buildChangedFilesReviewFileIndex(
            files.map(file => ({ fullPath: file.path, lockfile: file.lockfile }))), viewed);
        const summary = buildHunkReviewSummary(files, marked, viewed);
        expect([...summary.reviewedPaths]).toEqual(['b.ts']);
        expect(summary.reviewed).toBe(2);
        expect(movePreparedCursor(navigation, { path: 'c.ts', key: 'c1' }, 1, true))
            .toEqual({ path: 'yarn.lock', key: 'l1' });
        expect(movePreparedCursor(navigation, { path: 'yarn.lock', key: 'l1' }, 1, true))
            .toEqual({ path: 'a.ts', key: 'a1' });
        // Hunk movement still follows local Keep, including through a viewed file.
        expect(movePreparedCursor(navigation, { path: 'yarn.lock', key: 'l1' }, 1))
            .toEqual({ path: 'b.ts', key: 'b1' });
    });
    it('counts viewed image and metadata files without requiring a hunk', () => {
        const summary = buildHunkReviewSummary([{ path: 'a.png', keys: [] }, { path: 'b.png', keys: [] }],
            new Set(), new Set(['a.png']));
        expect(summary.files).toBe(2);
        expect([...summary.reviewedPaths]).toEqual(['a.png']);
    });
    it('reads only the cursor and destination when skipping 55,558 kept files in either direction', () => {
        let pathReads = 0;
        let keyReads = 0;
        const inventory = Array.from({ length: 55_559 }, (_, index): HunkReviewFile => ({
            get path() { pathReads += 1; return `src/file-${index}.ts`; },
            get keys() { keyReads += 1; return [`key-${index}`]; },
        }));
        const navigation = prepare(inventory, new Set(Array.from({ length: 55_558 }, (_, index) => `key-${index}`)));
        pathReads = 0;
        keyReads = 0;
        expect(movePreparedCursor(navigation, { path: 'src/file-0.ts', key: 'key-0' }, 1))
            .toEqual({ path: 'src/file-55558.ts', key: 'key-55558' });
        expect(movePreparedCursor(navigation, { path: 'src/file-0.ts', key: 'key-0' }, -1, true))
            .toEqual({ path: 'src/file-55558.ts', key: 'key-55558' });
        expect(pathReads).toBeLessThanOrEqual(4);
        expect(keyReads).toBeLessThanOrEqual(2);
        const allOpen = prepare(inventory, new Set());
        let rankReads = 0;
        const openRanks = new Proxy(allOpen.all.openRanks, {
            get(target, property, receiver) {
                if (typeof property === 'string' && /^\d+$/.test(property)) rankReads += 1;
                return Reflect.get(target, property, receiver);
            },
        });
        const measured = { ...allOpen, all: { ...allOpen.all, openRanks } };
        expect(movePreparedCursor(measured, { path: 'src/file-55557.ts', key: 'key-55557' }, 1, true))
            .toEqual({ path: 'src/file-55558.ts', key: 'key-55558' });
        expect(movePreparedCursor(measured, { path: 'src/file-55557.ts', key: 'key-55557' }, -1, true))
            .toEqual({ path: 'src/file-55556.ts', key: 'key-55556' });
        // One binary search and destination read per move, independent of cursor distance.
        expect(rankReads).toBeLessThanOrEqual(2 * (Math.ceil(Math.log2(inventory.length)) + 2));
        const sourceViewed = buildHunkReviewNavigation(inventory, new Set(), buildChangedFilesReviewFileIndex(
            inventory.map(file => ({ fullPath: file.path }))), new Set(inventory.slice(0, -1).map(file => file.path)));
        pathReads = 0;
        keyReads = 0;
        const index = sourceViewed.fileViewed!;
        index.setViewed('src/file-12.ts', false);
        index.setViewed('src/file-55558.ts', true);
        expect(movePreparedCursor(sourceViewed, { path: 'src/file-0.ts', key: 'key-0' }, 1, true))
            .toEqual({ path: 'src/file-12.ts', key: 'key-12' });
        expect(movePreparedCursor(sourceViewed, { path: 'src/file-0.ts', key: 'key-0' }, -1, true))
            .toEqual({ path: 'src/file-12.ts', key: 'key-12' });
        expect(index.reviewedPaths.size).toBe(55_558);
        expect(pathReads).toBeLessThanOrEqual(2);
        expect(keyReads).toBeLessThanOrEqual(3);
        expect(sourceViewed.fileViewed).toBe(index);
    });
    it('keeps loaded image and metadata files reachable through file navigation', () => {
        expect(moveHunkReviewCursor([{ path: 'a.png', keys: [] }, { path: 'b.png', keys: [] }],
            { path: 'a.png', key: null }, 1, new Set(), true)).toEqual({ path: 'b.png', key: null });
    });
    it('classifies live paths with no captured metadata through the canonical path classifier', () => {
        expect(prepare([{ path: 'a.ts', keys: ['a'] }, { path: 'yarn.lock', keys: ['lock'] },
            { path: 'z.ts', keys: ['z'] }], new Set()).changes.files.map(file => file.path)).toEqual(['a.ts', 'z.ts', 'yarn.lock']);
    });
    it('re-resolves a stable key after unrelated movement, but refuses changed content and another source scope', () => {
        const unit = { key: 'same-content' };
        expect(resolveHunkReviewUnit({ renderedScopeId: 'scope', currentScopeId: 'scope', key: unit.key,
            units: [{ key: 'inserted' }, unit] })).toBe(unit);
        expect(resolveHunkReviewUnit({ renderedScopeId: 'scope', currentScopeId: 'scope', key: unit.key, units: [] })).toBeNull();
        expect(resolveHunkReviewUnit({ renderedScopeId: 'scope', currentScopeId: 'other', key: unit.key, units: [unit] })).toBeNull();
    });
    it('moves by change, skips kept files across the boundary, and leaves generated files until last', () => {
        const marked = new Set(['b1']);
        expect(moveHunkReviewCursor(files, null, 1, marked)).toEqual({ path: 'a.ts', key: 'a1' });
        expect(moveHunkReviewCursor(files, { path: 'a.ts', key: 'a1' }, 1, marked)).toEqual({ path: 'a.ts', key: 'a2' });
        expect(moveHunkReviewCursor(files, { path: 'a.ts', key: 'a2' }, 1, marked)).toEqual({ path: 'c.ts', key: 'c1' });
        expect(moveHunkReviewCursor(files, { path: 'c.ts', key: 'c1' }, 1, marked)).toEqual({ path: 'yarn.lock', key: 'l1' });
        expect(moveHunkReviewCursor(files, { path: 'a.ts', key: 'a1' }, 1, marked, true)).toEqual({ path: 'c.ts', key: 'c1' });
    });

    it('counts content keys across files and marks a file reviewed only when every run is kept', () => {
        const summary = buildHunkReviewSummary(files, new Set(['a1', 'b1', 'not-in-this-capture']));
        expect(summary).toMatchObject({ reviewed: 2, total: 5, files: 4, remaining: 3 });
        expect([...summary.reviewedPaths]).toEqual(['b.ts']);
        expect(buildHunkReviewSummary([], new Set()).total).toBe(0);
        expect(moveHunkReviewCursor([], null, 1, new Set())).toBeNull();
    });

    it('can enter a pending diff without inventing a change identity', () => {
        expect(moveHunkReviewCursor([{ path: 'a.ts', keys: ['a1'] }, { path: 'b.ts', keys: [], pending: true }],
            { path: 'a.ts', key: 'a1' }, 1, new Set())).toEqual({ path: 'b.ts', key: null });
    });

    it('resolves a moved key by identity and wraps only after there are no unreviewed destinations', () => {
        const marked = new Set(['a1', 'a2', 'b1', 'l1', 'c1']);
        expect(moveHunkReviewCursor(files, { path: 'a.ts', key: 'a2' }, 1, marked)).toEqual({ path: 'b.ts', key: 'b1' });
        expect(moveHunkReviewCursor([{ path: 'a.ts', keys: ['before', 'a1', 'a2'] }], { path: 'a.ts', key: 'a1' }, 1, new Set()))
            .toEqual({ path: 'a.ts', key: 'a2' });
    });
});

describe('live review list across diff arrivals', () => {
    const diff = (path: string, text: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${text}\n`;
    const paths = Array.from({ length: 59_449 }, (_, index) => `src/file-${index}.ts`);
    const loaded = (entries: readonly (readonly [string, string])[]) =>
        new Map(entries.map(([path, text]) => [path, { status: 'loaded' as const, diff: diff(path, text) }]));

    it('keeps the list when only a load starts, and replaces only the row whose diff arrived', () => {
        const first = buildLiveReviewFiles(undefined, paths, loaded([[paths[0]!, 'a'], [paths[1]!, 'b']]));
        const loading = new Map<string, Readonly<{ status: 'loaded' | 'loading'; diff: string }>>([...loaded([[paths[0]!, 'a'], [paths[1]!, 'b']]), [paths[2]!, { status: 'loading', diff: '' }]]);
        expect(buildLiveReviewFiles(first, paths, loading), 'a started load changes no row').toBe(first);

        const arrived = buildLiveReviewFiles(first, paths, loaded([[paths[0]!, 'a'], [paths[1]!, 'b'], [paths[2]!, 'c']]));
        expect(arrived).not.toBe(first);
        const changedRows = arrived.filter((row, index) => row !== first[index]).map(row => row.path);
        expect(changedRows).toEqual([paths[2]]);
    });

    it('re-derives units and rows only for the file whose row changed', () => {
        const first = paths.map((path, index) => ({ path, unifiedDiff: index < 2 ? diff(path, String(index)) : '', pending: index >= 2 }));
        const arrived = first.slice();
        arrived[2] = { path: paths[2]!, unifiedDiff: diff(paths[2]!, 'c'), pending: false };
        const before = getLiveReviewBase(first);
        const after = getLiveReviewBase(arrived);
        const rederived = paths.filter(path => after.unitsByPath.get(path) !== before.unitsByPath.get(path));
        expect(rederived, 'unchanged files keep their units and rows').toEqual([paths[2]]);
        expect(after.files[1]).toBe(before.files[1]);
        expect(after.files[2]!.keys).toHaveLength(1);
        expect(after.files[2]!.pending).toBe(false);
        expect(after.files[3]!.pending).toBe(true);
    });
});
