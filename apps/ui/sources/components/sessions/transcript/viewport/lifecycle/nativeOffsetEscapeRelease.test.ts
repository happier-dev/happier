import { describe, expect, it } from 'vitest';

import type { TranscriptBottomFollowModeState } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';

import {
    resolveNativeOffsetEscapeReleaseDecision,
    resolveNativeOffsetReleaseLiveTailStateEffects,
    type NativeOffsetReleaseLiveTailInputEffect,
} from './nativeOffsetEscapeRelease';

const following: TranscriptBottomFollowModeState = {
    dragSession: null,
    mode: 'following',
};

const escaping: TranscriptBottomFollowModeState = {
    dragSession: {
        latestDistanceFromBottom: 96,
        returnedToBottom: false,
        sawAwayMovement: true,
        trusted: true,
    },
    mode: 'escaping',
};

const offsetReleaseEffect = (
    overrides: Partial<NativeOffsetReleaseLiveTailInputEffect> = {},
): NativeOffsetReleaseLiveTailInputEffect => ({
    distanceFromLiveTailPx: 96,
    sessionId: 'session-a',
    type: 'native-offset-release-live-tail',
    ...overrides,
});

describe('native offset escape release decision', () => {
    it('blocks stale following offsets when no active user-owned native gesture can claim the movement', () => {
        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: following,
            distanceFromLiveTailPx: 96,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({
            reason: 'following-without-user-ownership',
            type: 'blocked',
        });
    });

    it('blocks non-native, unpinned, active-restore, rearmed-following, missing-distance, and near-bottom cases', () => {
        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: escaping,
            distanceFromLiveTailPx: 96,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: false,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ reason: 'non-native', type: 'blocked' });

        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: escaping,
            distanceFromLiveTailPx: 96,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            wantsPinned: false,
        })).toEqual({ reason: 'not-pinned', type: 'blocked' });

        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: escaping,
            distanceFromLiveTailPx: 96,
            hasActiveNativeViewportRestore: true,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ reason: 'active-native-viewport-restore', type: 'blocked' });

        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: following,
            distanceFromLiveTailPx: 96,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: true,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ reason: 'rearmed-following', type: 'blocked' });

        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: escaping,
            distanceFromLiveTailPx: null,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ reason: 'missing-distance', type: 'blocked' });

        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: escaping,
            distanceFromLiveTailPx: 72,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ reason: 'inside-pin-threshold', type: 'blocked' });
    });

    it('releases only when the stale offset is user-owned and past the pin threshold', () => {
        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: escaping,
            distanceFromLiveTailPx: 96,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ type: 'release' });

        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: following,
            distanceFromLiveTailPx: 96,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: false,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: true,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ type: 'release' });

        expect(resolveNativeOffsetEscapeReleaseDecision({
            bottomFollowState: following,
            distanceFromLiveTailPx: 96,
            hasActiveNativeViewportRestore: false,
            hasNativeTouchStart: true,
            hasRearmedNativeBottomFollow: false,
            isNative: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
            wantsPinned: true,
        })).toEqual({ type: 'release' });
    });
});

describe('native offset release live-tail state effects', () => {
    it('returns no state effects when no offset release effect exists', () => {
        expect(resolveNativeOffsetReleaseLiveTailStateEffects({
            bottomFollowState: following,
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('ignores stale-session offset release effects', () => {
        expect(resolveNativeOffsetReleaseLiveTailStateEffects({
            bottomFollowState: following,
            effects: [offsetReleaseEffect({ sessionId: 'session-b' })],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns one state effect for a current-session offset release', () => {
        expect(resolveNativeOffsetReleaseLiveTailStateEffects({
            bottomFollowState: following,
            effects: [offsetReleaseEffect()],
            sessionId: 'session-a',
        })).toEqual([{
            bottomFollowState: following,
            sessionId: 'session-a',
            type: 'apply-native-offset-release-live-tail-state',
        }]);
    });

    it('filters mixed effects down to the current-session offset release', () => {
        expect(resolveNativeOffsetReleaseLiveTailStateEffects({
            bottomFollowState: following,
            effects: [
                offsetReleaseEffect({ sessionId: 'session-b' }),
                {
                    distanceFromLiveTailPx: 3,
                    sessionId: 'session-a',
                    type: 'native-touch-release-live-tail',
                },
                offsetReleaseEffect(),
            ],
            sessionId: 'session-a',
        })).toEqual([{
            bottomFollowState: following,
            sessionId: 'session-a',
            type: 'apply-native-offset-release-live-tail-state',
        }]);
    });

    it('preserves first-match behavior when multiple current-session offset release effects exist', () => {
        expect(resolveNativeOffsetReleaseLiveTailStateEffects({
            bottomFollowState: following,
            effects: [
                offsetReleaseEffect({ distanceFromLiveTailPx: 120 }),
                offsetReleaseEffect({ distanceFromLiveTailPx: 180 }),
            ],
            sessionId: 'session-a',
        })).toEqual([{
            bottomFollowState: following,
            sessionId: 'session-a',
            type: 'apply-native-offset-release-live-tail-state',
        }]);
    });
});
