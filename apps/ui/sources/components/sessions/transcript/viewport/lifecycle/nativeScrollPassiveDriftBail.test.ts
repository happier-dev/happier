import { describe, expect, it } from 'vitest';

import {
    resolveNativeScrollPassiveDriftBailDecision,
    resolveNativeScrollPassiveDriftBailGenericEffects,
} from './nativeScrollPassiveDriftBail';

describe('native scroll passive-drift bail decision', () => {
    it('suppresses generic observations for native passive drift while following', () => {
        expect(resolveNativeScrollPassiveDriftBailDecision({
            bottomFollowMode: 'following',
            followIntentIsPinned: false,
            followIntentWantsPinned: true,
            isNative: true,
            isTrusted: false,
        })).toEqual({ type: 'suppress-generic-observation' });
    });

    it('continues for web and trusted observations', () => {
        expect(resolveNativeScrollPassiveDriftBailDecision({
            bottomFollowMode: 'following',
            followIntentIsPinned: false,
            followIntentWantsPinned: true,
            isNative: false,
            isTrusted: false,
        })).toEqual({
            reason: 'not-native',
            type: 'continue',
        });

        expect(resolveNativeScrollPassiveDriftBailDecision({
            bottomFollowMode: 'following',
            followIntentIsPinned: false,
            followIntentWantsPinned: true,
            isNative: true,
            isTrusted: true,
        })).toEqual({
            reason: 'trusted-observation',
            type: 'continue',
        });
    });

    it('continues when follow state or resolved intent does not match native passive drift', () => {
        const nativeDrift = {
            bottomFollowMode: 'following' as const,
            followIntentIsPinned: false,
            followIntentWantsPinned: true,
            isNative: true,
            isTrusted: false,
        };

        expect(resolveNativeScrollPassiveDriftBailDecision({
            ...nativeDrift,
            bottomFollowMode: 'released',
        })).toEqual({
            reason: 'not-following',
            type: 'continue',
        });

        expect(resolveNativeScrollPassiveDriftBailDecision({
            ...nativeDrift,
            followIntentWantsPinned: false,
        })).toEqual({
            reason: 'not-wants-live-tail',
            type: 'continue',
        });

        expect(resolveNativeScrollPassiveDriftBailDecision({
            ...nativeDrift,
            followIntentIsPinned: true,
        })).toEqual({
            reason: 'visible-live-tail',
            type: 'continue',
        });
    });

    it('packages suppress decisions as session-scoped generic-observation suppression effects', () => {
        expect(resolveNativeScrollPassiveDriftBailGenericEffects({
            decision: { type: 'suppress-generic-observation' },
            sessionId: 'session-a',
        })).toEqual([{
            reason: 'native-passive-drift',
            sessionId: 'session-a',
            type: 'suppress-generic-scroll-observation',
        }]);
    });

    it('returns no effects for continue decisions', () => {
        expect(resolveNativeScrollPassiveDriftBailGenericEffects({
            decision: { reason: 'not-native', type: 'continue' },
            sessionId: 'session-a',
        })).toEqual([]);
        expect(resolveNativeScrollPassiveDriftBailGenericEffects({
            decision: { reason: 'trusted-observation', type: 'continue' },
            sessionId: 'session-a',
        })).toEqual([]);
        expect(resolveNativeScrollPassiveDriftBailGenericEffects({
            decision: { reason: 'not-following', type: 'continue' },
            sessionId: 'session-a',
        })).toEqual([]);
        expect(resolveNativeScrollPassiveDriftBailGenericEffects({
            decision: { reason: 'not-wants-live-tail', type: 'continue' },
            sessionId: 'session-a',
        })).toEqual([]);
        expect(resolveNativeScrollPassiveDriftBailGenericEffects({
            decision: { reason: 'visible-live-tail', type: 'continue' },
            sessionId: 'session-a',
        })).toEqual([]);
    });
});
