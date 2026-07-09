import { describe, expect, it } from 'vitest';

import {
    type NativeScrollAwayGestureLiveTailBailDecision,
    type NativeScrollAwayGestureLiveTailBailEffect,
    resolveNativeScrollAwayGestureLiveTailBailDecision,
    resolveNativeScrollAwayGestureLiveTailBailEffects,
} from './nativeScrollAwayGestureLiveTailBail';

const nativeScrollAwayGestureLiveTailBailEffectTypes = {
    'consume-observation': true,
    'observe-native-scroll-facts': true,
} satisfies Record<NativeScrollAwayGestureLiveTailBailEffect['type'], true>;

type ResolveNativeScrollAwayGestureLiveTailBailEffectsInput = Readonly<{
    decision: NativeScrollAwayGestureLiveTailBailDecision;
    distanceFromLiveTailPx: number;
    isTrusted: boolean;
    movedAwayFromLiveTail: boolean;
    movedTowardLiveTail: boolean;
    nativeListDragActive: boolean;
    recentUserIntent: boolean;
    sessionId: string;
}>;

function resolveBailEffects(
    overrides: Partial<ResolveNativeScrollAwayGestureLiveTailBailEffectsInput> = {},
): readonly NativeScrollAwayGestureLiveTailBailEffect[] {
    return resolveNativeScrollAwayGestureLiveTailBailEffects({
        decision: { type: 'bail' },
        distanceFromLiveTailPx: 24,
        isTrusted: false,
        movedAwayFromLiveTail: false,
        movedTowardLiveTail: false,
        nativeListDragActive: false,
        recentUserIntent: false,
        sessionId: 'session-1',
        ...overrides,
    });
}

describe('native scroll away gesture live-tail bail decision', () => {
    it('bails for an open native away gesture on an untrusted near-live-tail frame', () => {
        expect(resolveNativeScrollAwayGestureLiveTailBailDecision({
            distanceFromLiveTailPx: 72,
            hasOpenTrustedAwayGesture: true,
            isNative: true,
            isTrusted: false,
            pinThresholdPx: 72,
        })).toEqual({ type: 'bail' });
    });

    it('continues on web even if the gesture facts otherwise look like a bail', () => {
        expect(resolveNativeScrollAwayGestureLiveTailBailDecision({
            distanceFromLiveTailPx: 0,
            hasOpenTrustedAwayGesture: true,
            isNative: false,
            isTrusted: false,
            pinThresholdPx: 72,
        })).toEqual({ reason: 'not-native', type: 'continue' });
    });

    it('continues when no trusted away gesture is open', () => {
        expect(resolveNativeScrollAwayGestureLiveTailBailDecision({
            distanceFromLiveTailPx: 0,
            hasOpenTrustedAwayGesture: false,
            isNative: true,
            isTrusted: false,
            pinThresholdPx: 72,
        })).toEqual({ reason: 'no-open-trusted-away-gesture', type: 'continue' });
    });

    it('continues for trusted native frames so normal release/rearm handling can run', () => {
        expect(resolveNativeScrollAwayGestureLiveTailBailDecision({
            distanceFromLiveTailPx: 0,
            hasOpenTrustedAwayGesture: true,
            isNative: true,
            isTrusted: true,
            pinThresholdPx: 72,
        })).toEqual({ reason: 'trusted-observation', type: 'continue' });
    });

    it('continues outside the live-tail threshold', () => {
        expect(resolveNativeScrollAwayGestureLiveTailBailDecision({
            distanceFromLiveTailPx: 73,
            hasOpenTrustedAwayGesture: true,
            isNative: true,
            isTrusted: false,
            pinThresholdPx: 72,
        })).toEqual({ reason: 'outside-live-tail-threshold', type: 'continue' });
    });

    it('continues for non-finite distance facts to preserve the original threshold comparison', () => {
        expect(resolveNativeScrollAwayGestureLiveTailBailDecision({
            distanceFromLiveTailPx: Number.NaN,
            hasOpenTrustedAwayGesture: true,
            isNative: true,
            isTrusted: false,
            pinThresholdPx: 72,
        })).toEqual({ reason: 'outside-live-tail-threshold', type: 'continue' });
    });

    it('emits observe-scroll-facts before consume when an active native drag is still open', () => {
        expect(resolveBailEffects({
            distanceFromLiveTailPx: 24,
            isTrusted: false,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            nativeListDragActive: true,
            recentUserIntent: true,
            sessionId: 'session-1',
        })).toEqual([
            {
                distanceFromLiveTailPx: 24,
                isTrusted: false,
                movedAwayFromLiveTail: true,
                movedTowardLiveTail: false,
                recentUserIntent: true,
                sessionId: 'session-1',
                type: 'observe-native-scroll-facts',
            },
            { type: 'consume-observation', sessionId: 'session-1' },
        ]);
    });

    it('does not expose the deleted non-inverted read-only live-tail effect', () => {
        const effects = resolveBailEffects({
            distanceFromLiveTailPx: 12,
            isTrusted: false,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: true,
            nativeListDragActive: false,
            recentUserIntent: false,
            sessionId: 'session-1',
        });

        expect(Object.keys(nativeScrollAwayGestureLiveTailBailEffectTypes)).not.toContain(
            'record-non-inverted-read-only-live-tail',
        );
        expect(effects.map((effect) => effect.type)).toEqual(['consume-observation']);
    });

    it('emits consume for inverted bails even when no writes are needed', () => {
        expect(resolveBailEffects({
            distanceFromLiveTailPx: 0,
            isTrusted: false,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: false,
            nativeListDragActive: false,
            recentUserIntent: false,
            sessionId: 'session-1',
        })).toEqual([{ type: 'consume-observation', sessionId: 'session-1' }]);
    });

    it('returns no effects for continue decisions', () => {
        expect(resolveBailEffects({
            decision: { reason: 'trusted-observation', type: 'continue' },
            distanceFromLiveTailPx: 0,
            isTrusted: true,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            nativeListDragActive: true,
            recentUserIntent: true,
            sessionId: 'session-1',
        })).toEqual([]);
    });
});
