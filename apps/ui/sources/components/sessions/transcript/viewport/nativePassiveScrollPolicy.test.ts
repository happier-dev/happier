import { describe, expect, it } from 'vitest';

import {
    resolveNativePassiveBottomDriftNoiseFloorPx,
    shouldIgnoreNativeInvalidScrollObservation,
    shouldIgnoreNativePassiveViewportScroll,
    shouldRecordNativePassiveUnpinnedMovement,
} from './nativePassiveScrollPolicy';

describe('native passive scroll policy', () => {
    it('caps passive bottom-drift noise by the pinned threshold', () => {
        expect(resolveNativePassiveBottomDriftNoiseFloorPx({
            configuredBottomDistanceNoiseFloorPx: 24,
            pinThresholdPx: 12,
        })).toBe(12);
        expect(resolveNativePassiveBottomDriftNoiseFloorPx({
            configuredBottomDistanceNoiseFloorPx: 6,
            pinThresholdPx: 12,
        })).toBe(6);
        expect(resolveNativePassiveBottomDriftNoiseFloorPx({
            configuredBottomDistanceNoiseFloorPx: Number.NaN,
            pinThresholdPx: 12,
        })).toBe(0);
    });

    it('ignores impossible native negative offsets without suppressing ordinary top bounce', () => {
        expect(shouldIgnoreNativeInvalidScrollObservation({
            contentHeight: 24578,
            distanceFromBottom: 996655,
            isWeb: false,
            layoutHeight: 682,
            offsetY: -972759,
        })).toBe(true);

        expect(shouldIgnoreNativeInvalidScrollObservation({
            contentHeight: 24578,
            distanceFromBottom: -972759,
            isWeb: false,
            layoutHeight: 682,
            offsetY: -972759,
        })).toBe(true);

        expect(shouldIgnoreNativeInvalidScrollObservation({
            contentHeight: 24578,
            distanceFromBottom: 23928,
            isWeb: false,
            layoutHeight: 682,
            offsetY: -32,
        })).toBe(false);

        expect(shouldIgnoreNativeInvalidScrollObservation({
            contentHeight: 24578,
            distanceFromBottom: 996655,
            isWeb: true,
            layoutHeight: 682,
            offsetY: -972759,
        })).toBe(false);
    });

    it('records passive unpinned movement only after native content and viewport ownership are established', () => {
        const base = {
            configuredBottomDistanceNoiseFloorPx: 4,
            distanceFromBottom: 40,
            isWeb: false,
            pinThresholdPx: 16,
            wantsPinned: false,
        };

        expect(shouldRecordNativePassiveUnpinnedMovement({
            ...base,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: true,
        })).toBe(true);
        expect(shouldRecordNativePassiveUnpinnedMovement({
            ...base,
            hasNativeContentMeasurement: false,
            hasNativeInitialViewportApplied: true,
        })).toBe(false);
        expect(shouldRecordNativePassiveUnpinnedMovement({
            ...base,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: false,
        })).toBe(false);
        expect(shouldRecordNativePassiveUnpinnedMovement({
            ...base,
            distanceFromBottom: 4,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: true,
        })).toBe(false);
    });

    it('ignores passive native viewport scrolls that are unmeasured, near noise, or from an unrestored entry viewport', () => {
        expect(shouldIgnoreNativePassiveViewportScroll({
            configuredBottomDistanceNoiseFloorPx: 4,
            currentSessionId: 'session-a',
            distanceFromBottom: 40,
            entryViewportSessionId: null,
            entryViewportShouldFollowBottom: null,
            hasNativeContentMeasurement: false,
            hasNativeInitialViewportApplied: true,
            isTrusted: false,
            isWeb: false,
            nowMs: 1000,
            lastUserScrollIntentAtMs: Number.NEGATIVE_INFINITY,
            pinThresholdPx: 16,
            shouldRecordPassiveUnpinnedMovement: false,
            userIntentRecentMs: 500,
            wantsPinned: false,
        })).toBe(true);

        expect(shouldIgnoreNativePassiveViewportScroll({
            configuredBottomDistanceNoiseFloorPx: 4,
            currentSessionId: 'session-a',
            distanceFromBottom: 4,
            entryViewportSessionId: null,
            entryViewportShouldFollowBottom: null,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: true,
            isTrusted: false,
            isWeb: false,
            nowMs: 1000,
            lastUserScrollIntentAtMs: Number.NEGATIVE_INFINITY,
            pinThresholdPx: 16,
            shouldRecordPassiveUnpinnedMovement: false,
            userIntentRecentMs: 500,
            wantsPinned: false,
        })).toBe(true);

        expect(shouldIgnoreNativePassiveViewportScroll({
            configuredBottomDistanceNoiseFloorPx: 4,
            currentSessionId: 'session-a',
            distanceFromBottom: 40,
            entryViewportSessionId: 'session-a',
            entryViewportShouldFollowBottom: false,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: false,
            isTrusted: false,
            isWeb: false,
            nowMs: 1000,
            lastUserScrollIntentAtMs: Number.NEGATIVE_INFINITY,
            pinThresholdPx: 16,
            shouldRecordPassiveUnpinnedMovement: false,
            userIntentRecentMs: 500,
            wantsPinned: false,
        })).toBe(true);
    });

    it('keeps trusted and recent-user-intent scrolls observable', () => {
        const base = {
            configuredBottomDistanceNoiseFloorPx: 4,
            currentSessionId: 'session-a',
            distanceFromBottom: 40,
            entryViewportSessionId: null,
            entryViewportShouldFollowBottom: null,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: true,
            isWeb: false,
            nowMs: 1000,
            pinThresholdPx: 16,
            shouldRecordPassiveUnpinnedMovement: false,
            userIntentRecentMs: 500,
            wantsPinned: false,
        };

        expect(shouldIgnoreNativePassiveViewportScroll({
            ...base,
            isTrusted: true,
            lastUserScrollIntentAtMs: Number.NEGATIVE_INFINITY,
        })).toBe(false);
        expect(shouldIgnoreNativePassiveViewportScroll({
            ...base,
            isTrusted: false,
            lastUserScrollIntentAtMs: 700,
        })).toBe(false);
    });
});
