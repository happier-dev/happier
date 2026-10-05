import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from './ReviewFinding.js';
import type { ScmComparison, ScmDiffSummaryWalkthrough } from '../scm/index.js';
import { projectReviewFindingsOverlay, type ReviewFindingsOverlayReview } from './projectReviewFindingsOverlay';

const runRef = { runId: 'run-1', callId: 'call-1', backendId: 'codex' };
const finding: ReviewFinding = { id: 'f1', title: 'Issue', severity: 'high', category: 'correctness', summary: 'Issue', filePath: 'src/new.ts', startLine: 12, endLine: 13 };
const comparison: ScmComparison = {
    id: 'basis', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: { before: 'a', after: 'b' },
    inventory: { state: 'complete', reasons: [], files: [{
        path: 'src/new.ts', previousPath: 'src/old.ts', changeKind: 'renamed', binary: false, generated: false, lockfile: false,
        evidence: { state: 'available', unifiedDiff: '@@ -20,3 +10,4 @@' },
        occurrences: [{ id: 'exact-1', alias: 'c1', path: 'src/new.ts', previousPath: 'src/old.ts', position: 0, before: { startLine: 20, lineCount: 3 }, after: { startLine: 10, lineCount: 4 } },
            { id: 'exact-2', alias: 'c2', path: 'src/new.ts', previousPath: 'src/old.ts', position: 1, before: { startLine: 40, lineCount: 3 }, after: { startLine: 30, lineCount: 4 } }],
    }] },
};
const walkthrough: ScmDiffSummaryWalkthrough = { title: 'Changes', intro: '', stops: [
    { id: 'stop-1', title: 'First', explanationMarkdown: 'First', changeRefs: ['exact-1'], importance: 'low' },
    { id: 'stop-2', title: 'Second', explanationMarkdown: 'Second', changeRefs: ['exact-2'] },
], otherChangeRefs: [] };
const review: ReviewFindingsOverlayReview = { runRef, comparisonId: comparison.id, findings: [finding], status: 'succeeded', hasOutput: true };

describe('projectReviewFindingsOverlay', () => {
    it('maps rename after and before ranges to exact occurrences/stops, preserving severity and full run identity', () => {
        const before = { ...finding, id: 'before', filePath: 'src/old.ts', startLine: 21, endLine: 22 };
        const result = projectReviewFindingsOverlay({ comparison, walkthrough, reviews: [review, { ...review, runRef: { ...runRef, runId: 'run-2' }, findings: [before] }] });
        expect(result.entries).toMatchObject([
            { runRef, finding, state: 'mapped', changeRefs: ['exact-1'], stopIds: ['stop-1'], side: 'after' },
            { runRef: { ...runRef, runId: 'run-2' }, state: 'mapped', changeRefs: ['exact-1'], stopIds: ['stop-1'], side: 'before' },
        ]);
        expect(result.entries[0]?.finding.severity).toBe('high');
        expect(walkthrough.stops[0]?.importance).toBe('low');
    });

    it('retains unbound, foreign, stale, unavailable and ambiguous findings in the navigation tail', () => {
        for (const [basis, engine, reason] of [
            [comparison, { ...review, comparisonId: undefined }, 'comparison_unbound'],
            [comparison, { ...review, comparisonId: 'other' }, 'comparison_mismatch'],
            [{ ...comparison, freshness: 'stale' as const }, review, 'comparison_stale'],
            [{ ...comparison, inventory: { ...comparison.inventory, files: comparison.inventory.files.map((file) => ({ ...file, evidence: { state: 'unavailable' as const, reason: 'missing' } })) } }, review, 'evidence_unavailable'],
            [comparison, { ...review, findings: [{ ...finding, filePath: 'absent.ts' }] }, 'location_missing'],
        ] as const) {
            const result = projectReviewFindingsOverlay({ comparison: basis, walkthrough, reviews: [engine] });
            expect(result.entries).toHaveLength(1);
            expect(result.tail).toEqual(result.entries);
            expect(result.entries[0]).toMatchObject({ reason, finding: engine.findings[0], changeRefs: [], stopIds: [] });
        }
        const sameSides = { ...comparison, inventory: { ...comparison.inventory, files: comparison.inventory.files.map((file) => ({ ...file, previousPath: undefined, occurrences: file.occurrences.map((occurrence) => ({ ...occurrence, previousPath: undefined, before: occurrence.after })) })) } };
        expect(projectReviewFindingsOverlay({ comparison: sameSides, reviews: [review] }).tail[0]?.reason).toBe('side_ambiguous');
    });

    it('uses explicit deletion side and never selects a zero-line after range or a model alias', () => {
        const deleted = { ...comparison, inventory: { ...comparison.inventory, files: comparison.inventory.files.map((file) => ({ ...file, changeKind: 'deleted', occurrences: [{ ...file.occurrences[0]!, after: { startLine: 19, lineCount: 0 } }] })) } };
        const result = projectReviewFindingsOverlay({ comparison: deleted, walkthrough: { ...walkthrough, stops: [{ ...walkthrough.stops[0]!, changeRefs: ['c1'] }] }, reviews: [{ ...review, findings: [{ ...finding, filePath: 'src/old.ts', startLine: 20, endLine: 22 }] }] });
        expect(result.entries[0]).toMatchObject({ state: 'mapped', side: 'before', changeRefs: ['exact-1'], stopIds: [] });
    });

    it('maps a multi-hunk range without dropping the second occurrence and respects explicit comment side', () => {
        const ranged = { ...review, findings: [{ ...finding, startLine: 12, endLine: 31 }], anchorsByFindingId: { f1: { kind: 'range' as const, filePath: finding.filePath!, startLine: 12, endLine: 31, side: 'after' as const } } };
        expect(projectReviewFindingsOverlay({ comparison, walkthrough, reviews: [ranged] }).entries[0]).toMatchObject({ changeRefs: ['exact-1', 'exact-2'], stopIds: ['stop-1', 'stop-2'], side: 'after' });
    });
    it('keeps exact mapped findings without a walkthrough stop in the unattached corridor', () => {
        for (const narration of [undefined, { ...walkthrough, stops: [], otherChangeRefs: ['exact-1', 'exact-2'] }]) {
            const result = projectReviewFindingsOverlay({ comparison, walkthrough: narration, reviews: [review] });
            expect(result.tail).toEqual(result.entries);
            expect(result.tail[0]).toMatchObject({ state: 'mapped', changeRefs: ['exact-1'], stopIds: [] });
        }
    });

    it('never calls failed, running, partial or missing-output empty reviews clean', () => {
        for (const incomplete of [
            { ...review, findings: [], status: 'failed' as const },
            { ...review, findings: [], status: 'running' as const },
            { ...review, findings: [], hasOutput: false },
            { ...review, findings: [], findingsTruncated: true },
            { ...review, findings: [], comparisonId: undefined },
            { ...review, findings: [], comparisonId: 'other' },
        ]) expect(projectReviewFindingsOverlay({ comparison, reviews: [incomplete] }).status).toBe('incomplete');
        expect(projectReviewFindingsOverlay({ comparison, reviews: [] }).status).toBe('incomplete');
        expect(projectReviewFindingsOverlay({ comparison, reviews: [{ ...review, findings: [] }] }).status).toBe('clean');
        expect(projectReviewFindingsOverlay({ comparison, reviews: [review] }).status).toBe('findings');
    });
    it('does not call a partial review outcome or incomplete captured comparison clean despite runtime success', () => {
        for (const reviewOutcome of ['partial', 'failed', 'unavailable'] as const) {
            expect(projectReviewFindingsOverlay({ comparison, reviews: [{ ...review, findings: [], reviewOutcome }] }).status).toBe('incomplete');
        }
        expect(projectReviewFindingsOverlay({ comparison: { ...comparison, inventory: { ...comparison.inventory, state: 'incomplete' } },
            reviews: [{ ...review, findings: [] }] }).status).toBe('incomplete');
    });
    it('does not call empty reviews clean when captured change evidence is unavailable', () => {
        const unavailable = { ...comparison, inventory: { ...comparison.inventory, files: comparison.inventory.files.map((file) => ({
            ...file, evidence: { state: 'unavailable' as const, reason: 'capture failed' },
        })) } };
        expect(projectReviewFindingsOverlay({ comparison: unavailable, reviews: [{ ...review, findings: [] }] }).status).toBe('incomplete');
    });

    it('does not map the same line coordinates onto different staged and unstaged evidence', () => {
        const layers = { ...comparison, inventory: { ...comparison.inventory, files: comparison.inventory.files.map((file) => ({ ...file, occurrences: [
            { ...file.occurrences[0]!, layer: 'staged' as const },
            { ...file.occurrences[0]!, id: 'unstaged', alias: 'c3', layer: 'unstaged' as const },
        ] })) } };
        const result = projectReviewFindingsOverlay({ comparison: layers, reviews: [review] });
        expect(result.tail[0]).toMatchObject({ state: 'unmapped', reason: 'evidence_ambiguous', changeRefs: [] });
    });

    it('keeps usable occurrence evidence from a partially unavailable mixed-layer file', () => {
        const partial = { ...comparison, inventory: { ...comparison.inventory, state: 'incomplete' as const, reasons: ['missing layer'], files: comparison.inventory.files.map((file) => ({ ...file,
            evidence: { state: 'unavailable' as const, reason: 'missing layer' },
            occurrences: file.occurrences.map((occurrence) => ({ ...occurrence, evidence: { state: 'available' as const } })),
        })) } };
        expect(projectReviewFindingsOverlay({ comparison: partial, reviews: [review] }).entries[0]).toMatchObject({ state: 'mapped', changeRefs: ['exact-1'] });
    });
});
