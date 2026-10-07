import { describe, expect, it } from 'vitest';
import type { ScmComparison, ScmReviewedMarksRecord } from '@happier-dev/protocol';
import { createTwoFilesPatch, parsePatch } from 'diff';
import { SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from '@/components/dev/changes/walkthroughSpecimenFixture';

import { buildWalkthroughReading, buildWalkthroughReadingProgress, type WalkthroughReadingInput } from './walkthroughReading';

const A_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' import x from "x";',
    '+import y from "y";',
    ' ',
    ' const a = 1;',
    '@@ -20,3 +21,3 @@ export function a() {',
    '     const key = 1;',
    '-    return key;',
    '+    return key + 1;',
    ' }',
].join('\n');
const B_DIFF = [
    'diff --git a/src/b.ts b/src/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1,2 @@',
    '+export const b = 1;',
    '+export const c = 2;',
].join('\n');
const LOCK_DIFF = [
    'diff --git a/yarn.lock b/yarn.lock',
    '--- a/yarn.lock',
    '+++ b/yarn.lock',
    '@@ -10,1 +10,1 @@',
    '-"x@1": 1',
    '+"x@2": 2',
].join('\n');

const range = (startLine: number, lineCount: number) => ({ startLine, lineCount });
const COMPARISON: ScmComparison = {
    id: 'cmp-1',
    source: { kind: 'session', sessionId: 's1' },
    repository: { rootPath: '/repo' },
    endpoints: { before: 'b0', after: 'a0' },
    inventory: {
        state: 'complete',
        reasons: [],
        files: [
            {
                path: 'src/a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: A_DIFF },
                occurrences: [
                    { id: 'a0', alias: 'c1', path: 'src/a.ts', before: range(1, 3), after: range(1, 4), position: 0 },
                    { id: 'a1', alias: 'c2', path: 'src/a.ts', before: range(20, 3), after: range(21, 3), position: 1 },
                ],
            },
            {
                path: 'src/b.ts', changeKind: 'added', binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: B_DIFF },
                occurrences: [{ id: 'b0', alias: 'c3', path: 'src/b.ts', before: range(0, 0), after: range(1, 2), position: 0 }],
            },
            {
                path: 'yarn.lock', changeKind: 'modified', binary: false, generated: false, lockfile: true,
                evidence: { state: 'available', unifiedDiff: LOCK_DIFF },
                occurrences: [{ id: 'l0', alias: 'c4', path: 'yarn.lock', before: range(10, 1), after: range(10, 1), position: 0 }],
            },
            {
                path: 'art/hero.png', changeKind: 'modified', binary: true, generated: false, lockfile: false,
                evidence: { state: 'unavailable', reason: 'binary' },
                occurrences: [{ id: 'p0', alias: 'c5', path: 'art/hero.png', before: range(0, 0), after: range(0, 0), position: 0, evidence: { state: 'unavailable', reason: 'binary' } }],
            },
        ],
    },
};

const WALKTHROUGH = {
    title: 'Keep the key stable',
    intro: 'The key changed on every render.',
    stops: [
        { id: 'stop-why', title: 'Why it remounted', explanationMarkdown: 'Because of the key.', changeRefs: ['a0'], importance: 'high' as const },
        { id: 'stop-hook', title: 'One key', explanationMarkdown: 'A new module and its caller.', changeRefs: ['b0', 'a1'] },
    ],
    otherChangeRefs: ['l0', 'p0'],
};

function input(overrides: Partial<WalkthroughReadingInput> = {}): WalkthroughReadingInput {
    return {
        comparison: COMPARISON,
        walkthrough: { state: 'complete', value: WALKTHROUGH },
        analysis: { suppliedChangeRefs: ['a0', 'a1', 'b0', 'l0'], analysedChangeRefs: ['a0', 'a1', 'b0'], remainingChangeRefs: ['l0', 'p0'] },
        reviewed: null,
        ...overrides,
    };
}

describe('buildWalkthroughReading', () => {
    it('projects the Board next stop and personal progress without reading 214 files of diff evidence', () => {
        let evidenceReads = 0;
        const files = Array.from({ length: 214 }, (_, index) => {
            const path = `src/file-${index}.ts`;
            return {
                ...COMPARISON.inventory.files[0]!, path,
                evidence: { state: 'available' as const, get unifiedDiff() { evidenceReads += 1; return A_DIFF; } },
                occurrences: [{ ...COMPARISON.inventory.files[0]!.occurrences[0]!, id: `change-${index}`, path }],
            };
        });
        const comparison = { ...COMPARISON, inventory: { ...COMPARISON.inventory, files } };
        const value = { ...WALKTHROUGH, stops: files.map((file, index) => ({
            id: `stop-${index}`, title: `Stop ${index}`, explanationMarkdown: 'Explanation', changeRefs: [file.occurrences[0]!.id],
        })), otherChangeRefs: [] };
        const projected = buildWalkthroughReadingProgress(input({ comparison, walkthrough: { state: 'complete', value },
            reviewed: { v: 1, comparisonId: comparison.id, reviewedChangeRefs: ['change-0'] } }));
        expect(projected).toMatchObject({ phase: 'complete', title: WALKTHROUGH.title, reviewedCount: 1 });
        expect(projected.stops.find((stop) => !stop.reviewed)?.title).toBe('Stop 1');
        expect(evidenceReads).toBe(0);
        const updated = buildWalkthroughReadingProgress(input({ comparison, walkthrough: { state: 'complete', value },
            reviewed: { v: 1, comparisonId: comparison.id, reviewedChangeRefs: ['change-0', 'change-1'] } }));
        expect(updated.reviewedCount).toBe(2);
        expect(updated.stops.find((stop) => !stop.reviewed)?.title).toBe('Stop 2');
        expect(evidenceReads).toBe(0);
    });

    it.each(['stops', 'otherChanges'] as const)('keeps malformed captured evidence unavailable and out of complete totals in %s', (placement) => {
        const unifiedDiff = A_DIFF.replace('@@ -1,3 +1,4 @@', '@@ -1,30 +1,40 @@');
        const file = { ...COMPARISON.inventory.files[0]!, evidence: { state: 'available' as const, unifiedDiff } };
        const reading = buildWalkthroughReading(input({ comparison: { ...COMPARISON, inventory: { ...COMPARISON.inventory, files: [file] } },
            walkthrough: { state: 'complete', value: placement === 'stops' ? WALKTHROUGH : {
                ...WALKTHROUGH, stops: [], otherChangeRefs: file.occurrences.map((occurrence) => occurrence.id),
            } },
        }));
        if (placement === 'stops') {
            expect(reading.stops[0]!.files[0]).toMatchObject({ unifiedDiff: '', unavailableReason: 'invalid_diff' });
            expect(reading.stops[1]!.files[0]!.unifiedDiff).not.toBe('');
            expect(reading.stops[1]!.files[0]!.unavailableReason).toBeNull();
        } else expect(reading.others[0]).toMatchObject({ unavailableReason: 'invalid_diff' });
        expect(reading.source.linesKnown).toBe(false);
        expect(reading.inventory[0]!.reading).toBe('unavailable');
    });

    it('classifies each captured file once when many stops explain its evidence', () => {
        let evidenceStateReads = 0;
        const occurrences = Array.from({ length: 80 }, (_, index) => ({
            id: `change-${index}`, alias: `c${index}`, path: 'src/a.ts', position: index,
            before: range(index * 10 + 1, 1), after: range(index * 10 + 1, 1),
        }));
        const file = { ...COMPARISON.inventory.files[0]!, occurrences, evidence: {
            get state() { evidenceStateReads += 1; return 'available' as const; },
            unifiedDiff: ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
                ...occurrences.map((occurrence) => `@@ -${occurrence.before.startLine} +${occurrence.after.startLine} @@\n-before\n+after`),
            ].join('\n') + '\n',
        } };
        const comparison = { ...COMPARISON, inventory: { ...COMPARISON.inventory, files: [file] } };
        const reading = buildWalkthroughReading(input({ comparison, walkthrough: { state: 'complete', value: {
            ...WALKTHROUGH, stops: Array.from({ length: 80 }, (_, index) => ({
                id: `stop-${index}`, title: `Stop ${index}`, explanationMarkdown: 'Shared exact evidence.', changeRefs: [occurrences[index]!.id],
            })), otherChangeRefs: [],
        } } }));
        expect(reading.stops).toHaveLength(80);
        expect(reading.stops.every((stop) => stop.files[0]!.unifiedDiff !== '')).toBe(true);
        expect(evidenceStateReads).toBe(1);
    });
    it('preserves real patch whitespace and no-newline markers when selecting a hunk', () => {
        const unifiedDiff = createTwoFilesPatch('src/a.ts', 'src/a.ts', 'before\n \n', 'after\n \n');
        const file = { ...COMPARISON.inventory.files[0]!, evidence: { state: 'available' as const, unifiedDiff }, occurrences: [COMPARISON.inventory.files[0]!.occurrences[0]!] };
        const reading = buildWalkthroughReading(input({ comparison: { ...COMPARISON, inventory: { ...COMPARISON.inventory, files: [file] } } }));
        const patch = reading.stops[0]!.files[0]!.unifiedDiff;
        expect(parsePatch(patch)[0]?.hunks[0]?.lines).toEqual(['-before', '+after', '  ']);

        const noNewline = createTwoFilesPatch('src/a.ts', 'src/a.ts', 'before', 'after');
        const withMarkers = buildWalkthroughReading(input({ comparison: { ...COMPARISON, inventory: { ...COMPARISON.inventory, files: [{ ...file, evidence: { state: 'available', unifiedDiff: noNewline } }] } } }));
        expect(parsePatch(withMarkers.stops[0]!.files[0]!.unifiedDiff)[0]?.hunks[0]?.lines).toContain('\\ No newline at end of file');
    });

    it('renders every specimen stop from a structurally complete patch', () => {
        const reading = buildWalkthroughReading(input({ comparison: SPECIMEN_COMPARISON, walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH } }));
        for (const stop of reading.stops) {
            for (const file of stop.files) {
                expect(file.unifiedDiff, file.path).not.toBe('');
                expect(() => parsePatch(file.unifiedDiff), file.path).not.toThrow();
            }
        }
    });
    it('places each stop above exactly its own hunks, in the stop’s file order', () => {
        const reading = buildWalkthroughReading(input());
        const hook = reading.stops[1]!;
        expect(hook.files.map((file) => file.path)).toEqual(['src/b.ts', 'src/a.ts']);
        const aHunks = hook.files[1]!.unifiedDiff;
        expect(aHunks).toContain('return key + 1;');
        expect(aHunks).not.toContain('import y from "y";');
        expect(hook.files[1]!.rangeLabel).toBe('L21–23');
        expect(hook.files[1]!).toMatchObject({ added: 1, removed: 1 });
        expect(hook.files[0]!).toMatchObject({ changeKind: 'added', added: 2, removed: 0 });
        expect(reading.stops[0]!.files[0]!.unifiedDiff).toContain('import y from "y";');
        expect(reading.stops[0]!.files[0]!.unifiedDiff).not.toContain('return key + 1;');
    });

    it('keeps source, analysis and your marks as three separate counts', () => {
        const reviewed: ScmReviewedMarksRecord = { v: 1, comparisonId: 'cmp-1', reviewedChangeRefs: ['a0'] };
        const reading = buildWalkthroughReading(input({ reviewed }));
        expect(reading.source).toMatchObject({ fileCount: 4, changeCount: 5, added: 5, removed: 2, unavailableCount: 1, inventoryState: 'complete' });
        expect(reading.analysis).toEqual({ analysed: 3, total: 5 });
        expect(reading.stops.map((stop) => stop.reviewed)).toEqual([true, false]);
        expect(reading.reviewedCount).toBe(1);
        // A mark on part of a stop's code is not a reviewed stop.
        const partial = buildWalkthroughReading(input({ reviewed: { v: 1, comparisonId: 'cmp-1', reviewedChangeRefs: ['b0'] } }));
        expect(partial.reviewedCount).toBe(0);
        // Marks of another comparison never apply.
        const foreign = buildWalkthroughReading(input({ reviewed: { v: 1, comparisonId: 'other', reviewedChangeRefs: ['a0'] } }));
        expect(foreign.reviewedCount).toBe(0);
    });

    it('keeps the other changes reachable with their evidence class and reason', () => {
        const reading = buildWalkthroughReading(input());
        expect(reading.others.map((other) => [other.path, other.lockfile, other.unavailableReason])).toEqual([
            ['yarn.lock', true, null],
            ['art/hero.png', false, 'binary'],
        ]);
    });

    it('derives the lifecycle from the output progress, never from empty prose', () => {
        expect(buildWalkthroughReading(input({ walkthrough: { state: 'pending' } })).phase).toBe('inventory');
        expect(buildWalkthroughReading(input({ walkthrough: { state: 'writing' } })).phase).toBe('inventory');
        const arriving = buildWalkthroughReading(input({ walkthrough: { state: 'writing', value: { ...WALKTHROUGH, stops: WALKTHROUGH.stops.slice(0, 1), otherChangeRefs: [] } } }));
        expect(arriving.phase).toBe('arriving');
        expect(arriving.stops).toHaveLength(1);
        const failed = buildWalkthroughReading(input({ walkthrough: { state: 'failed', value: WALKTHROUGH, reason: 'overloaded' } }));
        expect(failed.phase).toBe('failed');
        expect(failed.failureReason).toBe('overloaded');
        expect(failed.stops).toHaveLength(2);
        expect(buildWalkthroughReading(input({ walkthrough: null })).phase).toBe('none');
    });

    it('lists every file before prose, with what the model has read so far', () => {
        const reading = buildWalkthroughReading(input({ walkthrough: { state: 'writing' } }));
        expect(reading.inventory.map((row) => [row.path, row.reading])).toEqual([
            ['src/a.ts', 'read'],
            ['src/b.ts', 'read'],
            ['yarn.lock', 'reading'],
            ['art/hero.png', 'unavailable'],
        ]);
    });

    it('projects the same stops onto Files hunks in file order', () => {
        const reading = buildWalkthroughReading(input());
        expect(reading.stopNumbersByPath.get('src/a.ts')).toEqual([1, 2]);
        expect(reading.stopIdsByHunk.get('src/a.ts')).toEqual([['stop-why'], ['stop-hook']]);
        expect(reading.stopIdsByHunk.get('yarn.lock')).toEqual([[]]);
    });

    it('assigns Explain notes once at the first file hunk, preserving secondary order and empty hunks', () => {
        const reading = buildWalkthroughReading(input({
            walkthrough: { state: 'complete', value: { ...WALKTHROUGH, stops: [
                { ...WALKTHROUGH.stops[0]!, changeRefs: ['a1', 'a0', 'b0'] },
                { ...WALKTHROUGH.stops[1]!, changeRefs: ['a1'] },
            ] } },
            reviewed: { v: 1, comparisonId: COMPARISON.id, reviewedChangeRefs: ['a0', 'a1', 'b0'] },
        }));
        expect(reading.explainNotesByHunk.get('src/a.ts')).toEqual([
            [{ key: 'stop-why', stop: reading.stops[0], secondary: false }],
            [{ key: 'stop-hook', stop: reading.stops[1], secondary: true }],
        ]);
        expect(reading.explainNotesByHunk.get('src/b.ts')).toEqual([
            [{ key: 'stop-why', stop: reading.stops[0], secondary: false }],
        ]);
        expect(reading.explainNotesByHunk.get('yarn.lock')).toEqual([
            [{ key: 'none:0', stop: null, secondary: false }],
        ]);
        expect(reading.explainNotesByHunk.get('art/hero.png')).toEqual([]);
        expect(reading.explainNotesByHunk.get('src/a.ts')![0]![0]!.stop?.reviewed).toBe(true);
        const repeated = buildWalkthroughReading(input({ walkthrough: { state: 'complete', value: {
            ...WALKTHROUGH, stops: [{ ...WALKTHROUGH.stops[0]!, changeRefs: ['a0', 'a1'] }],
        } } }));
        // Already-explained hunks have no repeated note; this differs from an unassigned hunk.
        expect(repeated.explainNotesByHunk.get('src/a.ts')?.[1]).toEqual([]);
    });

    it('outlines each stop in the overview, and groups miniatures by folder past the readable count', () => {
        const reading = buildWalkthroughReading(input());
        expect(reading.codeMap.find((file) => file.path === 'src/a.ts')?.stopIds).toEqual(['stop-why', 'stop-hook']);
        expect(reading.codeMap.find((file) => file.path === 'yarn.lock')).toMatchObject({ generated: true, stopIds: [] });
        const many = Array.from({ length: 41 }, (_, index) => ({
            path: `pkg${index % 2}/f${index}.ts`, changeKind: 'modified', binary: false, generated: false, lockfile: false,
            evidence: { state: 'available' as const, unifiedDiff: `diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b` },
            occurrences: [{ id: `o${index}`, alias: `c${index}`, path: `pkg${index % 2}/f${index}.ts`, before: range(1, 1), after: range(1, 1), position: 0 }],
        }));
        const grouped = buildWalkthroughReading(input({ comparison: { ...COMPARISON, inventory: { ...COMPARISON.inventory, files: many } }, walkthrough: null }));
        expect(grouped.codeMap.map((group) => group.path)).toEqual(['pkg0', 'pkg1']);
    });
});
