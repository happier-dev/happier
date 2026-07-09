import { describe, expect, it } from 'vitest';

import { resolveNativeScrollFollowIntentRearmDecision } from './nativeScrollFollowIntentRearm';

describe('native scroll follow-intent rearm decision', () => {
    it('allows rearm when no trusted away gesture is open', () => {
        expect(resolveNativeScrollFollowIntentRearmDecision({
            hasOpenTrustedAwayGesture: false,
            isTrusted: false,
            movedTowardLiveTail: false,
        })).toEqual({ type: 'allow-rearm' });
    });

    it('blocks passive bottom-frame rearm while a trusted away gesture is open', () => {
        expect(resolveNativeScrollFollowIntentRearmDecision({
            hasOpenTrustedAwayGesture: true,
            isTrusted: false,
            movedTowardLiveTail: false,
        })).toEqual({
            reason: 'open-away-gesture-without-trusted-return',
            type: 'block-rearm',
        });
    });

    it('blocks trusted observations that do not move toward the live tail while a trusted away gesture is open', () => {
        expect(resolveNativeScrollFollowIntentRearmDecision({
            hasOpenTrustedAwayGesture: true,
            isTrusted: true,
            movedTowardLiveTail: false,
        })).toEqual({
            reason: 'open-away-gesture-without-trusted-return',
            type: 'block-rearm',
        });
    });

    it('allows trusted movement toward the live tail while a trusted away gesture is open', () => {
        expect(resolveNativeScrollFollowIntentRearmDecision({
            hasOpenTrustedAwayGesture: true,
            isTrusted: true,
            movedTowardLiveTail: true,
        })).toEqual({ type: 'allow-rearm' });
    });

    it('does not rearm from untrusted movement toward the live tail while a trusted away gesture is open', () => {
        expect(resolveNativeScrollFollowIntentRearmDecision({
            hasOpenTrustedAwayGesture: true,
            isTrusted: false,
            movedTowardLiveTail: true,
        })).toEqual({
            reason: 'open-away-gesture-without-trusted-return',
            type: 'block-rearm',
        });
    });
});
