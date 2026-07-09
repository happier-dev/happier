import { describe, expect, it } from 'vitest';

import { resolveNativeTrustedBottomArrivalEffects } from './nativeTrustedBottomArrival';

describe('native trusted bottom arrival', () => {
    it('emits a pinned adoption effect with truncated finite distance', () => {
        expect(resolveNativeTrustedBottomArrivalEffects({
            distanceFromLiveTailPx: 12.8,
            sessionId: 'session-a',
        })).toEqual([
            {
                distanceFromLiveTailPx: 12,
                sessionId: 'session-a',
                type: 'adopt-native-trusted-bottom-arrival',
                viewportState: {
                    isPinned: true,
                    offsetY: 0,
                    shouldRestoreViewport: false,
                },
            },
        ]);
    });

    it.each([
        ['null distance', null],
        ['negative distance', -4],
        ['infinite distance', Number.POSITIVE_INFINITY],
        ['NaN distance', Number.NaN],
    ] as const)('normalizes %s to live-tail distance zero', (_name, distanceFromLiveTailPx) => {
        expect(resolveNativeTrustedBottomArrivalEffects({
            distanceFromLiveTailPx,
            sessionId: 'session-a',
        })).toEqual([
            {
                distanceFromLiveTailPx: 0,
                sessionId: 'session-a',
                type: 'adopt-native-trusted-bottom-arrival',
                viewportState: {
                    isPinned: true,
                    offsetY: 0,
                    shouldRestoreViewport: false,
                },
            },
        ]);
    });
});
