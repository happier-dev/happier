import { describe, expect, it } from 'vitest';

import { nativeEntryRestoreObservationMatches } from './nativeEntryRestoreObservationPolicy';

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
