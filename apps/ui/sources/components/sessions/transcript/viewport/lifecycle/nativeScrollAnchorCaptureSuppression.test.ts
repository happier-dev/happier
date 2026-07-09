import { describe, expect, it } from 'vitest';

import { resolveNativeScrollObservationAnchorCaptureSuppression } from './nativeScrollAnchorCaptureSuppression';

describe('resolveNativeScrollObservationAnchorCaptureSuppression', () => {
    it('suppresses anchor capture for passive native movement without trusted momentum attribution', () => {
        expect(resolveNativeScrollObservationAnchorCaptureSuppression({
            nativeMomentumScrollActive: false,
            shouldSuppressNativeAnchorCapture: true,
            trustedDragSessionActive: false,
        })).toBe(true);
    });

    it('never suppresses anchor capture when the observation is allowed to refresh anchors', () => {
        expect(resolveNativeScrollObservationAnchorCaptureSuppression({
            nativeMomentumScrollActive: false,
            shouldSuppressNativeAnchorCapture: false,
            trustedDragSessionActive: false,
        })).toBe(false);
        expect(resolveNativeScrollObservationAnchorCaptureSuppression({
            nativeMomentumScrollActive: true,
            shouldSuppressNativeAnchorCapture: false,
            trustedDragSessionActive: true,
        })).toBe(false);
    });

    it('preserves anchor capture when active momentum carries trusted drag attribution', () => {
        expect(resolveNativeScrollObservationAnchorCaptureSuppression({
            nativeMomentumScrollActive: true,
            shouldSuppressNativeAnchorCapture: true,
            trustedDragSessionActive: true,
        })).toBe(false);
    });

    it('requires both active momentum and trusted drag attribution to preserve passive movement anchor capture', () => {
        expect(resolveNativeScrollObservationAnchorCaptureSuppression({
            nativeMomentumScrollActive: true,
            shouldSuppressNativeAnchorCapture: true,
            trustedDragSessionActive: false,
        })).toBe(true);
        expect(resolveNativeScrollObservationAnchorCaptureSuppression({
            nativeMomentumScrollActive: false,
            shouldSuppressNativeAnchorCapture: true,
            trustedDragSessionActive: true,
        })).toBe(true);
    });
});
