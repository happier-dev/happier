import { afterEach, describe, expect, it } from 'vitest';
import { applyScmReviewedMarkIntent } from '@happier-dev/protocol/scm/reviewedMarks';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { SPECIMEN_COMPARISON } from '@/components/dev/changes/walkthroughSpecimenFixture';

import type { WalkthroughReading, WalkthroughReadingInput } from './walkthroughReading';
import { useWalkthroughReading } from './useWalkthroughReading';

afterEach(standardCleanup);

describe('useWalkthroughReading', () => {
    it.each([215, 2_000])('does constant mark projection work across a %i-file reading and still delivers changed code', async (fileCount) => {
        let evidenceReads = 0;
        const files = Array.from({ length: fileCount }, (_, index) => {
            const path = `src/file-${index}.ts`;
            return {
                ...SPECIMEN_COMPARISON.inventory.files[0]!, path,
                evidence: {
                    get state() { evidenceReads += 1; return 'available' as const; },
                    unifiedDiff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`,
                },
                occurrences: [{ id: `change-${index}`, alias: `c${index}`, path, position: 0,
                    before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
            };
        });
        const comparison: ScmComparison = { ...SPECIMEN_COMPARISON, inventory: { ...SPECIMEN_COMPARISON.inventory, files } };
        const input: WalkthroughReadingInput = { comparison, reviewed: null, analysis: null,
            walkthrough: { state: 'complete', value: {
                title: 'The full reading', intro: '', otherChangeRefs: [],
                stops: files.map((file, index) => ({ id: `stop-${index}`, title: `Stop ${index}`,
                    explanationMarkdown: 'The captured code.', changeRefs: [file.occurrences[0]!.id] })),
            } } };
        // Resolve mark keys before measuring the reading projection; the Protocol owner
        // admits exact content keys once and is not the code-card projection under test.
        const firstMark = applyScmReviewedMarkIntent(comparison, null, ['change-0'], true);
        const secondMark = applyScmReviewedMarkIntent(comparison, firstMark, ['change-1'], true);
        const hook = await renderHook(useWalkthroughReading, { initialProps: input });
        const initial = hook.getCurrent()!;
        const source = initial.reviewedSource!;
        const publishedStops: string[] = [];
        let progressPublications = 0;
        const disposers = initial.stops.map(stop => source.subscribeStop(stop.id, () => publishedStops.push(stop.id)));
        disposers.push(source.subscribeProgress(() => { progressPublications++; }));
        let stopSelectionReads = 0;
        initial.stops.forEach(stop => {
            const refs = stop.changeRefs;
            Object.defineProperty(stop, 'changeRefs', { get: () => { stopSelectionReads++; return refs; } });
        });
        evidenceReads = 0;
        await hook.rerender({ ...input, reviewed: firstMark });
        const marked = hook.getCurrent()!;
        // Owner RED: one mark visited 216 / 2,001 selections at 215 / 2,000 files.
        // GREEN: only the changed stop is projected; unchanged rows receive no publication.
        expect(stopSelectionReads).toBeLessThanOrEqual(1);
        expect(publishedStops).toEqual(['stop-0']);
        expect(progressPublications).toBe(1);
        expect(evidenceReads).toBe(0);
        expect(marked.reviewedCount).toBe(1);
        expect(marked.stops[0]!.reviewed).toBe(true);
        expect(marked.stops[1]).toBe(initial.stops[1]);
        marked.stops.forEach((stop, index) => expect(stop.files).toBe(initial.stops[index]!.files));
        expect(marked.codeMap).toBe(initial.codeMap);
        expect(marked.inventory).toBe(initial.inventory);
        expect(marked.stopIdsByHunk).toBe(initial.stopIdsByHunk);
        expect(marked.explainNotesByHunk.get(files[0]!.path)?.[0]?.[0]?.stop).toBe(marked.stops[0]);
        expect(marked.explainNotesByHunk.get(files[1]!.path)).toBe(initial.explainNotesByHunk.get(files[1]!.path));

        await hook.rerender({ ...input, reviewed: secondMark });
        const twoMarks = hook.getCurrent()!;
        expect(twoMarks.reviewedCount).toBe(2);
        expect(twoMarks.stops[0]).toBe(marked.stops[0]);
        expect(twoMarks.stops[2]).toBe(initial.stops[2]);
        expect(publishedStops).toEqual(['stop-0', 'stop-1']);
        expect(progressPublications).toBe(2);
        await hook.rerender({ ...input, reviewed: { ...secondMark, reviewedChangeKeys: [...secondMark.reviewedChangeKeys] } });
        expect(hook.getCurrent()).toBe(twoMarks);
        expect(publishedStops).toEqual(['stop-0', 'stop-1']);
        expect(progressPublications).toBe(2);
        await hook.rerender(input);
        expect(hook.getCurrent()!.reviewedCount).toBe(0);
        expect(hook.getCurrent()!.stops.every(stop => !stop.reviewed)).toBe(true);
        expect(evidenceReads).toBe(0);
        expect(publishedStops).toEqual(['stop-0', 'stop-1', 'stop-0', 'stop-1']);
        expect(progressPublications).toBe(3);
        disposers.forEach(dispose => dispose());

        const changed = { ...comparison, inventory: { ...comparison.inventory, files: files.map((file, index) => index === 0
            ? { ...file, evidence: { state: 'available' as const, unifiedDiff: file.evidence.unifiedDiff.replace('+after', '+changed') } }
            : file) } };
        await hook.rerender({ ...input, comparison: changed, reviewed: firstMark });
        expect(hook.getCurrent()!.stops[0]!.files[0]!.unifiedDiff).toContain('+changed');
        expect(hook.getCurrent()!.stops[0]!.reviewed).toBe(false);
        expect(evidenceReads).toBeGreaterThan(0);
    });

    it('withdraws and recovers the projection when evidence is unavailable', async () => {
        const input: WalkthroughReadingInput = { comparison: SPECIMEN_COMPARISON, walkthrough: null, analysis: null, reviewed: null };
        const hook = await renderHook<WalkthroughReading | null, WalkthroughReadingInput | null>(
            next => useWalkthroughReading(next), { initialProps: input });
        expect(hook.getCurrent()).not.toBeNull();
        await hook.rerender(null);
        expect(hook.getCurrent()).toBeNull();
        await hook.rerender(input);
        expect(hook.getCurrent()!.source.fileCount).toBe(SPECIMEN_COMPARISON.inventory.files.length);
    });
});
