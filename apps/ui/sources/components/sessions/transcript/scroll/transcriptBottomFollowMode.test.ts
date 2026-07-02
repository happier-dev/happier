import { describe, expect, it } from 'vitest';

import {
    resolveTranscriptBottomFollowMode,
    type TranscriptBottomFollowModeState,
} from './transcriptBottomFollowMode';

function state(overrides: Partial<TranscriptBottomFollowModeState> = {}): TranscriptBottomFollowModeState {
    return {
        dragSession: null,
        mode: 'following',
        ...overrides,
    };
}

describe('transcript bottom-follow mode', () => {
    it('enters escaping when the native list drag starts', () => {
        expect(resolveTranscriptBottomFollowMode(state(), {
            type: 'list-drag-start',
        })).toMatchObject({
            mode: 'escaping',
            dragSession: {
                latestDistanceFromBottom: null,
                sawAwayMovement: false,
            },
        });
    });

    it('releases after trusted away movement beyond the pinned threshold', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: null,
                sawAwayMovement: false,
                trusted: true,
            },
            mode: 'escaping',
        }), {
            distanceFromBottom: 180,
            movedAwayFromBottom: true,
            pinThresholdPx: 72,
            type: 'trusted-away-observation',
        })).toMatchObject({
            dragSession: {
                latestDistanceFromBottom: 180,
                sawAwayMovement: true,
            },
            mode: 'released',
        });
    });

    it('does not rearm escaping from a passive bottom observation', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 180,
                sawAwayMovement: true,
                trusted: true,
            },
            mode: 'escaping',
        }), {
            distanceFromBottom: 0,
            pinThresholdPx: 72,
            type: 'passive-bottom-observation',
        })).toMatchObject({
            mode: 'escaping',
        });
    });

    it('returns to following on drag end only when no away movement happened and the latest distance is near bottom', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 24,
                sawAwayMovement: false,
                trusted: true,
            },
            mode: 'escaping',
        }), {
            distanceFromBottom: 24,
            pinThresholdPx: 72,
            sawAwayMovement: false,
            type: 'drag-end',
        })).toMatchObject({
            // The trusted session stays open as the pending-momentum release window (plan B9).
            dragSession: { trusted: true },
            mode: 'following',
        });

        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 160,
                sawAwayMovement: true,
                trusted: true,
            },
            mode: 'escaping',
        }), {
            distanceFromBottom: 160,
            pinThresholdPx: 72,
            sawAwayMovement: true,
            type: 'drag-end',
        })).toMatchObject({
            mode: 'released',
        });
    });

    it('rearms released mode only from explicit jump or trusted movement back near bottom', () => {
        expect(resolveTranscriptBottomFollowMode(state({ mode: 'released' }), {
            type: 'jump-to-bottom',
        })).toMatchObject({
            mode: 'following',
        });

        expect(resolveTranscriptBottomFollowMode(state({ mode: 'released' }), {
            distanceFromBottom: 40,
            movedTowardBottom: true,
            pinThresholdPx: 72,
            type: 'trusted-bottom-observation',
        })).toMatchObject({
            mode: 'following',
        });

        expect(resolveTranscriptBottomFollowMode(state({ mode: 'released' }), {
            distanceFromBottom: 0,
            pinThresholdPx: 72,
            type: 'passive-bottom-observation',
        })).toMatchObject({
            mode: 'released',
        });
    });

    it('does not rearm released mode from trusted movement back near bottom while the same drag is still active', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 180,
                sawAwayMovement: true,
                trusted: true,
            },
            mode: 'released',
        }), {
            distanceFromBottom: 40,
            movedTowardBottom: true,
            pinThresholdPx: 72,
            type: 'trusted-bottom-observation',
        })).toMatchObject({
            dragSession: {
                latestDistanceFromBottom: 40,
                sawAwayMovement: true,
            },
            mode: 'released',
        });
    });

    it('tracks a passive near-bottom observation during an active released drag without rearming before drag end', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 180,
                sawAwayMovement: true,
                trusted: true,
            },
            mode: 'released',
        }), {
            distanceFromBottom: 40,
            pinThresholdPx: 72,
            type: 'passive-bottom-observation',
        })).toMatchObject({
            dragSession: {
                latestDistanceFromBottom: 40,
                sawAwayMovement: true,
            },
            mode: 'released',
        });
    });

    it('rearms on drag end when the user returned near bottom during the drag', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 40,
                sawAwayMovement: true,
                trusted: true,
            },
            mode: 'released',
        }), {
            distanceFromBottom: 40,
            pinThresholdPx: 72,
            sawAwayMovement: true,
            type: 'drag-end',
        })).toMatchObject({
            // The trusted session stays open as the pending-momentum release window (plan B9).
            dragSession: { trusted: true },
            mode: 'following',
        });
    });

    it('re-follows at momentum settle when a trusted post-drag fling lands near the bottom (plan B8)', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 180,
                sawAwayMovement: true,
                trusted: true,
            },
            mode: 'released',
        }), {
            distanceFromBottom: 12,
            pinThresholdPx: 72,
            type: 'momentum-settle',
        })).toMatchObject({
            dragSession: null,
            mode: 'following',
        });
    });

    it('closes the post-drag attribution window at momentum settle away from the bottom (plan B8)', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 180,
                sawAwayMovement: true,
                trusted: true,
            },
            mode: 'released',
        }), {
            distanceFromBottom: 600,
            pinThresholdPx: 72,
            type: 'momentum-settle',
        })).toMatchObject({
            dragSession: null,
            mode: 'released',
        });
    });

    it('ignores momentum settle without a trusted post-drag session (plan B8)', () => {
        // No drag session: nothing to attribute the momentum to.
        expect(resolveTranscriptBottomFollowMode(state({ mode: 'released' }), {
            distanceFromBottom: 0,
            pinThresholdPx: 72,
            type: 'momentum-settle',
        })).toMatchObject({
            dragSession: null,
            mode: 'released',
        });

        // Untrusted session never grants follow at settle.
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 10,
                sawAwayMovement: true,
                trusted: false,
            },
            mode: 'released',
        }), {
            distanceFromBottom: 0,
            pinThresholdPx: 72,
            type: 'momentum-settle',
        })).toMatchObject({
            mode: 'released',
        });

        // Mid-drag (escaping) settles are drag-end's business.
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 10,
                sawAwayMovement: true,
                trusted: true,
            },
            mode: 'escaping',
        }), {
            distanceFromBottom: 0,
            pinThresholdPx: 72,
            type: 'momentum-settle',
        })).toMatchObject({
            mode: 'escaping',
        });
    });

    it('falls back to the drag session distance when momentum settle has no live metrics (plan B8)', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 12,
                sawAwayMovement: true,
                trusted: true,
            },
            mode: 'released',
        }), {
            distanceFromBottom: null,
            pinThresholdPx: 72,
            type: 'momentum-settle',
        })).toMatchObject({
            dragSession: null,
            mode: 'following',
        });
    });

    it('keeps the trusted drag session open when a drag ends near the bottom (plan B9 momentum-release window)', () => {
        // A hard flick lifts the finger inside the pin threshold while momentum is still
        // pending: re-arm following, but the attribution window must survive until
        // momentum-settle so the fling itself can still release.
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 40,
                sawAwayMovement: false,
                trusted: true,
            },
            mode: 'escaping',
        }), {
            distanceFromBottom: 40,
            pinThresholdPx: 72,
            sawAwayMovement: false,
            type: 'drag-end',
        })).toMatchObject({
            dragSession: {
                latestDistanceFromBottom: 40,
                trusted: true,
            },
            mode: 'following',
        });
    });

    it('releases at momentum settle when the post-drag fling carried the viewport away while following (plan B9)', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 40,
                sawAwayMovement: false,
                trusted: true,
            },
            mode: 'following',
        }), {
            distanceFromBottom: 7500,
            pinThresholdPx: 72,
            type: 'momentum-settle',
        })).toMatchObject({
            dragSession: null,
            mode: 'released',
        });
    });

    it('stays following and closes the window at momentum settle near the bottom while following (plan B9)', () => {
        expect(resolveTranscriptBottomFollowMode(state({
            dragSession: {
                latestDistanceFromBottom: 40,
                sawAwayMovement: false,
                trusted: true,
            },
            mode: 'following',
        }), {
            distanceFromBottom: 10,
            pinThresholdPx: 72,
            type: 'momentum-settle',
        })).toMatchObject({
            dragSession: null,
            mode: 'following',
        });
    });

    it('ignores momentum settle while following without a trusted session (plan B9 B6-safety)', () => {
        // No drag ever happened: a settle (e.g. from an animated programmatic scroll)
        // must never release follow by itself.
        expect(resolveTranscriptBottomFollowMode(state({ mode: 'following' }), {
            distanceFromBottom: 600,
            pinThresholdPx: 72,
            type: 'momentum-settle',
        })).toMatchObject({
            dragSession: null,
            mode: 'following',
        });
    });

    it('keeps content growth from releasing or rearming follow state by itself', () => {
        expect(resolveTranscriptBottomFollowMode(state({ mode: 'following' }), {
            type: 'content-growth',
        })).toMatchObject({
            mode: 'following',
        });

        expect(resolveTranscriptBottomFollowMode(state({ mode: 'released' }), {
            type: 'content-growth',
        })).toMatchObject({
            mode: 'released',
        });
    });
});
