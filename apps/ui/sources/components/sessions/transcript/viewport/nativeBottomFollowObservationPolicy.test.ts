import { describe, expect, it } from 'vitest';

import { resolveNativeBottomFollowCompletionEffects } from './nativeBottomFollowObservationPolicy';

describe('native bottom-follow observation policy', () => {
    it('completes renderer-held native follow after the bottom target is observed', () => {
        expect(resolveNativeBottomFollowCompletionEffects({
            contentHeight: 1800,
            distanceFromBottom: 0,
            isNative: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual([{
            entrySettleBaselineContentHeight: 1800,
            sessionId: 'session-a',
            type: 'complete-native-bottom-follow',
        }]);
    });

    it('does not complete outside an observed native live-tail target', () => {
        const base = {
            contentHeight: 1800,
            distanceFromBottom: 0,
            isNative: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            wantsPinned: true,
        } as const;

        expect(resolveNativeBottomFollowCompletionEffects({
            ...base,
            isNative: false,
        })).toEqual([]);
        expect(resolveNativeBottomFollowCompletionEffects({
            ...base,
            wantsPinned: false,
        })).toEqual([]);
        expect(resolveNativeBottomFollowCompletionEffects({
            ...base,
            distanceFromBottom: 73,
        })).toEqual([]);
    });
});
