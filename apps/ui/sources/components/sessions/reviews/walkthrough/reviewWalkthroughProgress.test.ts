import { describe, expect, it } from 'vitest';

import { resolveReviewWalkthroughProgress } from './reviewWalkthroughProgress';
import type { WalkthroughReviewSummary } from './reviewWalkthroughOverlay';

const summary = (overrides: Partial<WalkthroughReviewSummary>): WalkthroughReviewSummary => ({
    state: 'complete', total: 5, inStory: 3, elsewhere: 2, totalEngines: 2, finishedEngines: 2, runningEngines: 0,
    failedEngineLabels: [], failedEngineIds: [], finishedEngineLabels: ['Claude', 'Codex'], runningEngineLabels: [], engineLabels: ['Claude', 'Codex'], ...overrides,
});

describe('resolveReviewWalkthroughProgress', () => {
    it('names the walkthrough step from the start, while the review is still running', () => {
        expect(resolveReviewWalkthroughProgress({ review: summary({ state: 'running', finishedEngines: 0, runningEngines: 2, total: 0 }), narration: { state: 'pending', mode: 'continued_review', narratorLabel: 'Claude' } }))
            .toEqual({ review: { state: 'running', kind: 'reviewing' }, narration: { state: 'waiting', kind: 'writing' } });
    });

    it('publishes the findings first, then writes; ready when the walkthrough completes', () => {
        expect(resolveReviewWalkthroughProgress({ review: summary({}), narration: { state: 'writing', mode: 'continued_review', narratorLabel: 'Claude' } }))
            .toEqual({ review: { state: 'done', kind: 'reviewed', findings: 5 }, narration: { state: 'running', kind: 'writing' } });
        expect(resolveReviewWalkthroughProgress({ review: summary({}), narration: { state: 'complete', mode: 'continued_review', narratorLabel: 'Claude' } }).narration)
            .toEqual({ state: 'done', kind: 'ready' });
    });

    it('says who reviewed and who writes when a findings-only engine hands over to a narrator', () => {
        expect(resolveReviewWalkthroughProgress({
            review: summary({ total: 3, totalEngines: 1, finishedEngines: 1, engineLabels: ['CodeRabbit'] }),
            narration: { state: 'writing', mode: 'continued_review', narratorLabel: 'Claude', findingsOnlyReviewer: true },
        })).toEqual({ review: { state: 'done', kind: 'engine_reviewed', engine: 'CodeRabbit', findings: 3 }, narration: { state: 'running', kind: 'narrator_writing', narrator: 'Claude' } });
    });

    it('labels an after-the-fact walkthrough by its review time and whether it continues or narrates', () => {
        expect(resolveReviewWalkthroughProgress({ review: summary({}), reviewedAt: '11:04', narration: { state: 'writing', mode: 'continued_review', narratorLabel: 'Opus 5.5' } }))
            .toEqual({ review: { state: 'done', kind: 'reviewed_at', at: '11:04' }, narration: { state: 'running', kind: 'writing' } });
        expect(resolveReviewWalkthroughProgress({ review: summary({}), reviewedAt: '11:04', narration: { state: 'writing', mode: 'seeded_narrator', narratorLabel: 'Sonnet 5' } }))
            .toEqual({ review: { state: 'done', kind: 'review_at', at: '11:04' }, narration: { state: 'running', kind: 'narrating' } });
    });

    it('keeps a failed narration and a partial review visibly separate, and never as clean', () => {
        expect(resolveReviewWalkthroughProgress({ review: summary({}), narration: { state: 'failed', mode: 'continued_review', narratorLabel: 'Claude' } }).narration)
            .toEqual({ state: 'failed', kind: 'failed' });
        expect(resolveReviewWalkthroughProgress({ review: summary({ state: 'partial', finishedEngines: 1, total: 3, failedEngineLabels: ['Claude'] }), narration: null }))
            .toEqual({ review: { state: 'partial', kind: 'partial', findings: 3 }, narration: null });
    });

    it('names who is done and who still reviews when a review runs on its own', () => {
        expect(resolveReviewWalkthroughProgress({ review: summary({ state: 'running', finishedEngines: 1, runningEngines: 1, finishedEngineLabels: ['Claude'], runningEngineLabels: ['Codex'] }), narration: null }))
            .toEqual({ review: { state: 'running', kind: 'engines_reviewing', done: ['Claude'], running: ['Codex'] }, narration: null });
    });
});
