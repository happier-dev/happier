import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SPECIMEN_ANALYSIS_COMPLETE, SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from '@/components/dev/changes/walkthroughSpecimenFixture';
import { buildWalkthroughReading } from './walkthroughReading';

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
    it('names reviewers with unavailable files-read progress instead of inventing counts', async () => {
        const { ReviewWalkthroughSteps } = await import('@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts');
        const screen = await renderScreen(<ReviewWalkthroughSteps progress={{ review: { state: 'running', kind: 'engines_reviewing', done: ['Claude'], running: ['Codex'] }, narration: null }} />);
        expect(screen.findByTestId('walkthrough-engine-progress-unavailable')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Codex');
    });
    it('renders only host-projected parts and stop provenance, separately from reviewed marks', async () => {
        const projected = buildWalkthroughReading({ comparison: SPECIMEN_COMPARISON,
            walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH },
            analysis: { ...SPECIMEN_ANALYSIS_COMPLETE, parts: { admitted: 3, completed: 2, total: 5, phase: 'evidence' } }, reviewed: null,
            provenance: { titleEdited: true, stops: [{ stopId: SPECIMEN_WALKTHROUGH.stops[0]!.id, titleEdited: true, changedAtRevision: 4, movedAtRevision: 3 }] } });
        const screen = await renderScreen(<WalkthroughView reading={projected} scopeLabel="This session" layout="wide" />);
        expect(Boolean(screen.findByTestId('walkthrough-parts-progress'))).toBe(true);
        expect(Boolean(screen.findByTestId(`walkthrough-provenance-${projected.stops[0]!.id}`))).toBe(true);
        expect(projected.analysis?.parts).toEqual({ admitted: 3, completed: 2, total: 5, phase: 'evidence' });
        expect(reading.analysis?.parts).toBeUndefined();
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
