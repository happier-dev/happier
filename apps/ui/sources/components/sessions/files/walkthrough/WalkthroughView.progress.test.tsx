import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SPECIMEN_ANALYSIS_COMPLETE, SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from '@/components/dev/changes/walkthroughSpecimenFixture';
import { buildWalkthroughReading, type WalkthroughReadingInput } from './walkthroughReading';
import { useWalkthroughReading } from './useWalkthroughReading';
import { createWalkthroughReviewedSource } from './walkthroughReviewedProjection';
import { applyScmReviewedMarkIntent, type ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';
import { act, createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit';
import { ScmComparisonFactSentence } from '@/components/sessions/files/comparison/ScmComparisonHeader';

// Native rendering is external; the actual reading, stream, prose and progress owners remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { WalkthroughView } = await import('./WalkthroughView');
const reading = buildWalkthroughReading({ comparison: SPECIMEN_COMPARISON,
    walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH }, analysis: SPECIMEN_ANALYSIS_COMPLETE, reviewed: null });

describe('walkthrough personal progress availability', () => {
    it.each(['wide', 'phone'] as const)('keeps the %s mark control current without a parent render', async layout => {
        const source = createWalkthroughReviewedSource(reading, SPECIMEN_COMPARISON);
        let record: ScmReviewedMarksRecord | null = null;
        const screen = await renderScreen(<WalkthroughView reading={source.base} scopeLabel="This session" layout={layout}
            onToggleReviewed={stop => {
                record = applyScmReviewedMarkIntent(SPECIMEN_COMPARISON, record, stop.changeRefs, !stop.reviewed);
                source.apply(record);
            }} />);
        const control = layout === 'phone' ? 'walkthrough-phone-mark' : `walkthrough-mark-${reading.stops[0]!.id}`;
        try {
            await screen.pressByTestIdAsync(control);
            expect(screen.findByTestId(control)?.props['aria-checked']).toBe(true);
            expect(source.getReviewedCount()).toBe(1);
            await screen.pressByTestIdAsync(control);
            expect(screen.findByTestId(control)?.props['aria-checked']).toBe(false);
            expect(source.getReviewedCount()).toBe(0);
        } finally { await screen.unmount(); }
    });
    it.each([215, 2_000])('does not render unrelated contents rows after a single mark in a %i-file reading', async fileCount => {
        const files = Array.from({ length: fileCount }, (_, index) => {
            const path = `src/file-${index}.ts`;
            return { ...SPECIMEN_COMPARISON.inventory.files[0]!, path,
                evidence: { state: 'available' as const, unifiedDiff: `@@ -1 +1 @@\n-before\n+after\n` },
                occurrences: [{ id: `change-${index}`, alias: `c${index}`, path, position: 0,
                    before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }] };
        });
        const comparison = { ...SPECIMEN_COMPARISON, inventory: { ...SPECIMEN_COMPARISON.inventory, files } };
        const input: WalkthroughReadingInput = { comparison, analysis: null, reviewed: null,
            walkthrough: { state: 'complete', value: { title: 'Large reading', intro: '', otherChangeRefs: [],
                stops: files.map((file, index) => ({ id: `stop-${index}`, title: `Stop ${index}`,
                    explanationMarkdown: 'The captured change.', changeRefs: [file.occurrences[0]!.id] })) } } };
        const marked = applyScmReviewedMarkIntent(comparison, null, ['change-0'], true);
        const rowReads = new Set<string>();
        const onToggleReviewed = () => {};
        let instrumented = false;
        function Reading(props: Readonly<{ input: WalkthroughReadingInput }>) {
            const reading = useWalkthroughReading(props.input);
            if (!instrumented) {
                instrumented = true;
                for (const stop of reading.stops) {
                    const cue = stop.fileCue;
                    Object.defineProperty(stop, 'fileCue', { get: () => { rowReads.add(stop.id); return cue; } });
                }
            }
            return <WalkthroughView reading={reading} scopeLabel="This session" layout="wide" onToggleReviewed={onToggleReviewed} />;
        }
        const screen = await renderScreen(<Reading input={input} />);
        try {
            expect(rowReads.size).toBe(fileCount);
            rowReads.clear();
            await screen.update(<Reading input={{ ...input, reviewed: marked }} />);
            expect(rowReads.size).toBeLessThanOrEqual(1);
            expect(screen.findByTestId('walkthrough-mark-stop-0')?.props['aria-checked']).toBe(true);
            expect(screen.findByTestId('walkthrough-mark-stop-1')?.props['aria-checked']).toBe(false);
            expect(screen.findByTestId('walkthrough-reviewed-fact')?.findByType(ScmComparisonFactSentence).props.counts).toEqual([1, fileCount]);
            rowReads.clear();
            await screen.update(<Reading input={input} />);
            expect(rowReads.size).toBeLessThanOrEqual(1);
            expect(screen.findByTestId('walkthrough-mark-stop-0')?.props['aria-checked']).toBe(false);
            expect(screen.findByTestId('walkthrough-reviewed-fact')?.findByType(ScmComparisonFactSentence).props.counts).toEqual([0, fileCount]);
        } finally { await screen.unmount(); }
    });
    it('keeps all 215 unchanged code cards and unaffected stops out of mark and unmark renders', async () => {
        const files = Array.from({ length: 215 }, (_, index) => {
            const path = `src/file-${index}.ts`;
            return { ...SPECIMEN_COMPARISON.inventory.files[0]!, path,
                evidence: { state: 'available' as const, unifiedDiff: `@@ -1 +1 @@\n-before-${index}\n+after-${index}\n` },
                occurrences: [{ id: `change-${index}`, alias: `c${index}`, path, position: 0,
                    before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }] };
        });
        const comparison = { ...SPECIMEN_COMPARISON, inventory: { ...SPECIMEN_COMPARISON.inventory, files } };
        const base = buildWalkthroughReading({ comparison, analysis: null, reviewed: null,
            walkthrough: { state: 'complete', value: { title: 'Large reading', intro: '', otherChangeRefs: [], stops: [
                { id: 'main', title: 'Main stop', explanationMarkdown: 'The main reading.', changeRefs: files.slice(0, -1).map(file => file.occurrences[0]!.id) },
                { id: 'other', title: 'Other stop', explanationMarkdown: 'A separate stop.', changeRefs: ['change-214'] },
            ] } } });
        const codeReads = new Set<string>();
        let unaffectedStopReads = 0;
        for (const stop of base.stops) for (const file of stop.files) {
            const diff = file.unifiedDiff;
            Object.defineProperty(file, 'unifiedDiff', { get: () => { codeReads.add(file.path); return diff; } });
        }
        const other = base.stops[1]!;
        const explanation = other.explanationMarkdown;
        Object.defineProperty(other, 'explanationMarkdown', { get: () => { unaffectedStopReads++; return explanation; } });
        const counter = createRenderCommitCounter();
        const source = createWalkthroughReviewedSource(base, comparison);
        function Reading(props: Readonly<{ reading: typeof base }>) {
            useRenderCommitCounter(counter);
            return <WalkthroughView reading={props.reading} scopeLabel="This session" layout="wide" />;
        }
        const screen = await renderScreen(<Reading reading={source.base} />);
        expect(codeReads.size).toBe(215);
        expect(unaffectedStopReads).toBeGreaterThan(0);
        const markedRecord = applyScmReviewedMarkIntent(comparison, null, base.stops[0]!.changeRefs, true);
        try {
            for (const record of [markedRecord, null]) {
                codeReads.clear(); unaffectedStopReads = 0; counter.reset();
                await act(async () => { source.apply(record); });
                const next = source.getSnapshot();
                await screen.update(<Reading reading={source.base} />);
                expect(counter.read()).toEqual({ renders: 1, commits: 1 });
                expect(codeReads.size).toBe(0);
                expect(unaffectedStopReads).toBe(0);
                expect(next.stops[0]!.reviewed).toBe(record !== null);
                expect(screen.findByTestId('walkthrough-reviewed-fact')).not.toBeNull();
            }
        } finally { await screen.unmount(); }
    });
    it('names each reviewer once in the status, without inventing files-read counts or a word for the unknown', async () => {
        const { ReviewWalkthroughSteps } = await import('@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts');
        const screen = await renderScreen(<ReviewWalkthroughSteps progress={{ review: { state: 'running', kind: 'engines_reviewing', done: ['Claude'], running: ['Codex'] }, narration: null }} />);
        const text = screen.getTextContent();
        expect(text).toContain('Claude');
        expect(text.split('Codex')).toHaveLength(2);
        expect(text).not.toMatch(/\d+ of \d+/);
        expect(screen.findByTestId('walkthrough-engine-progress-unavailable')).toBeNull();
    });
    it('renders only host-projected parts and stop provenance, separately from reviewed marks', async () => {
        const projected = buildWalkthroughReading({ comparison: SPECIMEN_COMPARISON,
            walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH },
            analysis: { ...SPECIMEN_ANALYSIS_COMPLETE, parts: { completed: 2, total: 5, phase: 'evidence' } }, reviewed: null,
            provenance: { titleEdited: true, stops: [{ stopId: SPECIMEN_WALKTHROUGH.stops[0]!.id, titleEdited: true, changedAtRevision: 4, movedAtRevision: 3 }] } });
        const screen = await renderScreen(<WalkthroughView reading={projected} scopeLabel="This session" layout="wide" />);
        expect(Boolean(screen.findByTestId('walkthrough-parts-progress'))).toBe(true);
        expect(Boolean(screen.findByTestId(`walkthrough-provenance-${projected.stops[0]!.id}`))).toBe(true);
        expect(projected.analysis?.parts).toEqual({ completed: 2, total: 5, phase: 'evidence' });
        expect(reading.analysis?.parts).toBeUndefined();
    });
    it('says parts only while reading: a stopped reading says what it read, and never counts admitted parts', async () => {
        const parts = { completed: 1, total: 2, phase: 'evidence' } as const;
        const stopped = buildWalkthroughReading({ comparison: SPECIMEN_COMPARISON,
            walkthrough: { state: 'partial', value: { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 1) } },
            analysis: { ...SPECIMEN_ANALYSIS_COMPLETE, analysedChangeRefs: SPECIMEN_ANALYSIS_COMPLETE.analysedChangeRefs.slice(0, 3), parts }, reviewed: null });
        const screen = await renderScreen(<WalkthroughView reading={stopped} scopeLabel="This session" layout="wide" />);
        expect(screen.findByTestId('walkthrough-analysis-fact')).not.toBeNull();
        expect(screen.findByTestId('walkthrough-parts-progress')).toBeNull();
        const reading = buildWalkthroughReading({ comparison: SPECIMEN_COMPARISON,
            walkthrough: { state: 'writing', value: SPECIMEN_WALKTHROUGH }, analysis: { ...SPECIMEN_ANALYSIS_COMPLETE, parts }, reviewed: null });
        const writing = await renderScreen(<WalkthroughView reading={reading} scopeLabel="This session" layout="wide" />);
        expect(writing.findByTestId('walkthrough-parts-progress')).not.toBeNull();
    });
    it('does not publish unknown Account marks as zero, while known empty marks show genuine zero', async () => {
        const unknown = await renderScreen(<WalkthroughView reading={reading} scopeLabel="This session" layout="wide" reviewedProgressAvailable={false} />);
        expect(Boolean(unknown.findByTestId('walkthrough-reviewed-fact'))).toBe(false);
        expect(Boolean(unknown.findByTestId('walkthrough-contents-count'))).toBe(false);
        const known = await renderScreen(<WalkthroughView reading={reading} scopeLabel="This session" layout="wide" reviewedProgressAvailable />);
        expect(Boolean(known.findByTestId('walkthrough-reviewed-fact'))).toBe(true);
        expect(Boolean(known.findByTestId('walkthrough-contents-count'))).toBe(true);
    });
});
