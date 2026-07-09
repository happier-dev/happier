import { describe, expect, it } from 'vitest';

import {
    nativeEntryRestoreObservationMatches,
    resolveNativeSliceEntryObservation,
} from './nativeEntryRestoreObservationPolicy';

const baseTarget = {
    kind: 'distance' as const,
    offsetY: 360,
    sessionId: 'session-a',
};

describe('native entry restore observation policy', () => {
    it('matches a pending restore by restored bottom distance', () => {
        expect(nativeEntryRestoreObservationMatches({
            ...baseTarget,
        }, {
            contentHeight: 5000,
            distanceFromBottom: 363,
            observedOffsetY: 1200,
            sessionId: 'session-a',
            tolerancePx: 4,
        })).toBe(true);
    });

    it('matches a distance restore by target offset only after target content is ready', () => {
        expect(nativeEntryRestoreObservationMatches({
            ...baseTarget,
            contentHeight: 5000,
            targetOffsetY: 1200,
        }, {
            contentHeight: 4998,
            distanceFromBottom: 999,
            observedOffsetY: 1202,
            sessionId: 'session-a',
            tolerancePx: 4,
        })).toBe(true);

        expect(nativeEntryRestoreObservationMatches({
            ...baseTarget,
            contentHeight: 5000,
            targetOffsetY: 1200,
        }, {
            contentHeight: 4900,
            distanceFromBottom: 999,
            observedOffsetY: 1202,
            sessionId: 'session-a',
            tolerancePx: 4,
        })).toBe(false);
    });

    it('does not match clamped target offsets or another session', () => {
        expect(nativeEntryRestoreObservationMatches({
            ...baseTarget,
            targetOffsetY: 1200,
            targetOffsetYWasClamped: true,
        }, {
            contentHeight: 5000,
            distanceFromBottom: 999,
            observedOffsetY: 1200,
            sessionId: 'session-a',
            tolerancePx: 4,
        })).toBe(false);

        expect(nativeEntryRestoreObservationMatches(baseTarget, {
            contentHeight: 5000,
            distanceFromBottom: 360,
            observedOffsetY: 1200,
            sessionId: 'session-b',
            tolerancePx: 4,
        })).toBe(false);
    });
});

describe('slice-entry observation (N2b: anchored entry = zero writes, confirm by saved anchor offset)', () => {
    it('is inconclusive while the anchor row layout or scroll metrics are unavailable', () => {
        expect(resolveNativeSliceEntryObservation({
            anchorLayout: null,
            absoluteScrollOffset: 0,
            itemOffsetPx: 12,
            layoutHeight: 800,
            tolerancePx: 2,
        })).toBe('inconclusive');
        expect(resolveNativeSliceEntryObservation({
            anchorLayout: { y: Number.NaN, height: 120 },
            absoluteScrollOffset: 0,
            itemOffsetPx: 12,
            layoutHeight: 800,
            tolerancePx: 2,
        })).toBe('inconclusive');
        expect(resolveNativeSliceEntryObservation({
            anchorLayout: { y: 12, height: 120 },
            absoluteScrollOffset: Number.NaN,
            itemOffsetPx: 12,
            layoutHeight: 800,
            tolerancePx: 2,
        })).toBe('inconclusive');
        expect(resolveNativeSliceEntryObservation({
            anchorLayout: { y: 12, height: 120 },
            absoluteScrollOffset: 0,
            itemOffsetPx: 12,
            layoutHeight: 0,
            tolerancePx: 2,
        })).toBe('inconclusive');
    });

    it('aligns when the anchor row intersects the resting viewport at its saved pixel offset', () => {
        expect(resolveNativeSliceEntryObservation({
            anchorIndex: 0,
            anchorLayout: { y: 12, height: 120 },
            absoluteScrollOffset: 0,
            contentHeight: 2200,
            itemOffsetPx: 12,
            layoutHeight: 800,
            tolerancePx: 2,
            visibleRange: { startIndex: 0, endIndex: 4 },
        })).toBe('aligned');
        expect(resolveNativeSliceEntryObservation({
            anchorIndex: 0,
            anchorLayout: { y: 0, height: 120 },
            absoluteScrollOffset: 80,
            contentHeight: 2200,
            itemOffsetPx: -80,
            layoutHeight: 800,
            tolerancePx: 2,
            visibleRange: { startIndex: 0, endIndex: 4 },
        })).toBe('aligned');
    });

    it('misaligns a visible anchor row restored at the wrong saved pixel offset', () => {
        expect(resolveNativeSliceEntryObservation({
            anchorIndex: 0,
            anchorLayout: { y: 12, height: 120 },
            absoluteScrollOffset: 0,
            contentHeight: 2200,
            itemOffsetPx: 60,
            layoutHeight: 800,
            tolerancePx: 2,
            visibleRange: { startIndex: 0, endIndex: 4 },
        })).toBe('misaligned');
    });

    it('is inconclusive until usable content metrics prove the anchor row can settle in a scrollable window', () => {
        const base = {
            anchorIndex: 0,
            anchorLayout: { y: 12, height: 120 },
            absoluteScrollOffset: 0,
            itemOffsetPx: 12,
            layoutHeight: 800,
            tolerancePx: 2,
            visibleRange: { startIndex: 0, endIndex: 4 },
        } as const;

        expect(resolveNativeSliceEntryObservation({
            ...base,
            contentHeight: 0,
        })).toBe('inconclusive');
        expect(resolveNativeSliceEntryObservation({
            ...base,
            contentHeight: Number.NaN,
        })).toBe('inconclusive');
        expect(resolveNativeSliceEntryObservation({
            ...base,
            contentHeight: 799,
        })).toBe('inconclusive');
    });

    it('is inconclusive without visible-range proof even when stale layout intersects the viewport', () => {
        expect(resolveNativeSliceEntryObservation({
            anchorIndex: 0,
            anchorLayout: { y: 12, height: 120 },
            absoluteScrollOffset: 0,
            contentHeight: 2200,
            itemOffsetPx: 12,
            layoutHeight: 800,
            tolerancePx: 2,
            visibleRange: null,
        })).toBe('inconclusive');
    });

    it('does not align from layout intersection alone when the anchor index is outside the visible range', () => {
        expect(resolveNativeSliceEntryObservation({
            anchorIndex: 8,
            anchorLayout: { y: 12, height: 120 },
            absoluteScrollOffset: 0,
            itemOffsetPx: 12,
            layoutHeight: 800,
            tolerancePx: 2,
            visibleRange: { startIndex: 0, endIndex: 3 },
        })).toBe('misaligned');
    });

    it('reports misaligned when the anchor row is fully outside the viewport', () => {
        expect(resolveNativeSliceEntryObservation({
            anchorIndex: 8,
            anchorLayout: { y: 2000, height: 120 },
            absoluteScrollOffset: 0,
            contentHeight: 2200,
            itemOffsetPx: 2000,
            layoutHeight: 800,
            tolerancePx: 2,
            visibleRange: { startIndex: 0, endIndex: 10 },
        })).toBe('misaligned');
        expect(resolveNativeSliceEntryObservation({
            anchorIndex: 0,
            anchorLayout: { y: 0, height: 120 },
            absoluteScrollOffset: 600,
            contentHeight: 2200,
            itemOffsetPx: -600,
            layoutHeight: 800,
            tolerancePx: 2,
            visibleRange: { startIndex: 0, endIndex: 4 },
        })).toBe('misaligned');
    });
});
