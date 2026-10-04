import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { projectReviewFindingsOverlay, type ReviewFinding, type ReviewFindingsOverlayReview } from '@happier-dev/protocol';

import { SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from '@/components/dev/changes/walkthroughSpecimenFixture';

import { buildWalkthroughReviewOverlay } from './reviewWalkthroughOverlay';
import { buildWalkthroughReviewSlots } from './walkthroughReviewSlots';
import { sanitizeEnrichedMarkdownWithInlineReferences } from '@/components/markdown/enriched/enrichedMarkdownLinkHandling';
import { buildWalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';

const SHEET = 'apps/ui/sources/components/settings/SettingsSheet.tsx';
const KEY = 'apps/ui/sources/components/settings/useSettingsRouteKey.ts';
const finding = (id: string, severity: ReviewFinding['severity'], extra: Partial<ReviewFinding> = {}): ReviewFinding => ({
    id, title: `Finding ${id}`, severity, category: 'correctness', summary: `Why ${id} matters`, ...extra,
});
const run = (runId: string, backendId: string) => ({ runId, callId: `call-${runId}`, backendId });
// A modified hunk spans both sides; the finding's review comment anchor names the side it is about.
const afterSide = (findings: ReviewFinding[]) => Object.fromEntries(findings.filter((item) => item.filePath && item.startLine)
    .map((item) => [item.id, { kind: 'line' as const, filePath: item.filePath!, line: item.startLine!, side: 'after' as const }]));
const review = (runId: string, backendId: string, findings: ReviewFinding[], extra: Partial<ReviewFindingsOverlayReview> = {}): ReviewFindingsOverlayReview => ({
    runRef: run(runId, backendId), comparisonId: SPECIMEN_COMPARISON.id, findings, status: 'succeeded', hasOutput: true,
    anchorsByFindingId: afterSide(findings), ...extra,
});
const LABELS = { 'run-codex': 'Codex', 'run-claude': 'Claude' };

function overlayOf(reviews: ReviewFindingsOverlayReview[], walkthrough = SPECIMEN_WALKTHROUGH) {
    return buildWalkthroughReviewOverlay({
        overlay: projectReviewFindingsOverlay({ comparison: SPECIMEN_COMPARISON, walkthrough, reviews }),
        stops: walkthrough.stops,
        reviewerLabelByRunId: LABELS,
    });
}

describe('buildWalkthroughReviewOverlay', () => {
    it.each([
        { id: 'with spaces (finding:run-codex:other)', encoded: 'run-codex:with%20spaces%20%28finding:run-codex:other%29' },
        { id: 'literal%20escape', encoded: 'run-codex:literal%2520escape' },
    ])('resolves and presses one escaped citation for the exact published finding $id', ({ id, encoded }) => {
        const markdown = `See [the finding](finding:${encoded}) here.`;
        const walkthrough = { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.map((stop) =>
            stop.id === 'key' ? { ...stop, explanationMarkdown: markdown, findingRefs: [`run-codex:${id}`] } : stop) };
        const overlay = overlayOf([review('run-codex', 'codex', [
            finding(id, 'high', { filePath: SHEET, startLine: 11 }),
            finding('other', 'low', { filePath: KEY, startLine: 3 }),
            finding('literal escape', 'medium', { filePath: KEY, startLine: 3 }),
        ])], walkthrough);
        const slots = buildWalkthroughReviewSlots({ overlay, phone: false, severityColors: () => ({ foreground: '#c00', tint: '#fee' }) });
        const reading = buildWalkthroughReading({ comparison: SPECIMEN_COMPARISON,
            walkthrough: { state: 'complete', value: walkthrough }, analysis: null, reviewed: null });
        const scrollToStop = vi.fn();
        const findings = slots.renderStopFindings?.(reading.stops.find((stop) => stop.id === 'key')!, { scrollToStop });
        const references = findings?.proseReferences;
        expect(references?.resolve(encoded)).toMatchObject({ foreground: '#c00', background: '#fee' });
        references?.onPress?.(encoded);
        expect(scrollToStop).toHaveBeenCalledExactlyOnceWith('sheet');
        const rendered = sanitizeEnrichedMarkdownWithInlineReferences(markdown, references).markdown;
        expect(rendered.match(/\]\(happier-ref:finding:/g)).toHaveLength(1);
        expect(rendered).toContain(`](happier-ref:finding:${encoded})`);
        const trailingRefs = findings?.refs;
        expect(React.isValidElement<{ views: readonly unknown[] }>(trailingRefs) && trailingRefs.props.views).toEqual([]);

        scrollToStop.mockClear();
        expect(references?.resolve('run-codex:%E0%A4%A')).toBeNull();
        references?.onPress?.('run-codex:%E0%A4%A');
        expect(scrollToStop).not.toHaveBeenCalled();
    });

    it('places a mapped finding beside its stop and colours the rail by severity, never by importance', () => {
        const projected = overlayOf([review('run-codex', 'codex', [finding('f1', 'high', { filePath: SHEET, startLine: 11, endLine: 11 })])]);
        const sheet = projected.stops.get('sheet')!;
        expect(sheet.cards.map((card) => [card.findingId, card.severity, card.engineLabel])).toEqual([['f1', 'high', 'Codex']]);
        // A chip is the narrator citing the finding in prose; placement alone draws no chip.
        expect(sheet.refs).toEqual([]);
        expect(projected.railSeverityByStopId.get('sheet')).toBe('high');
        // "why" is the walkthrough's high-importance stop; it has no finding, so it gets no dot.
        expect(projected.railSeverityByStopId.has('why')).toBe(false);
        expect(projected.tail).toEqual([]);
    });

    it('resolves the narrator’s finding references to chips without duplicating the card in another stop', () => {
        const stops = SPECIMEN_WALKTHROUGH.stops.map((stop) => (stop.id === 'key' ? { ...stop, findingRefs: ['run-codex:f1', 'unknown'] } : stop));
        const projected = overlayOf([review('run-codex', 'codex', [finding('f1', 'high', { filePath: SHEET, startLine: 11 })])], { ...SPECIMEN_WALKTHROUGH, stops });
        expect(projected.stops.get('key')!.refs.map((ref) => ref.findingId)).toEqual(['f1']);
        expect(projected.stops.get('key')!.cards).toEqual([]);
        expect(projected.stops.get('sheet')!.cards.map((card) => card.findingId)).toEqual(['f1']);
    });

    it('keeps findings without a file, outdated ones and ones no stop explains in a reachable tail', () => {
        const projected = overlayOf([
            review('run-codex', 'codex', [
                finding('nofile', 'medium'),
                finding('mapped', 'low', { filePath: KEY, startLine: 3 }),
            ]),
            review('run-claude', 'claude', [finding('old', 'nit', { filePath: SHEET, startLine: 11 })], { comparisonId: 'older-comparison' }),
        ], { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.filter((stop) => stop.id !== 'key') });
        expect(projected.tail.map((entry) => [entry.findingId, entry.tag])).toEqual([
            ['nofile', 'no_file'],
            ['mapped', 'not_in_story'],
            ['old', 'outdated'],
        ]);
        expect(projected.summary).toMatchObject({ total: 3, inStory: 0, elsewhere: 3 });
    });

    it('never reads a failed or still-running engine as a clean review', () => {
        const partial = overlayOf([
            review('run-codex', 'codex', [finding('f1', 'high', { filePath: SHEET, startLine: 11 })]),
            review('run-claude', 'claude', [], { status: 'failed', hasOutput: false }),
        ]);
        expect(partial.summary).toMatchObject({ state: 'partial', finishedEngines: 1, totalEngines: 2, failedEngineLabels: ['Claude'] });
        const running = overlayOf([review('run-claude', 'claude', [], { status: 'running', hasOutput: false })]);
        expect(running.summary).toMatchObject({ state: 'running', total: 0, runningEngines: 1 });
        const clean = overlayOf([review('run-codex', 'codex', [])]);
        expect(clean.summary.state).toBe('complete');
    });
});
