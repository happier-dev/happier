import { describe, expect, it } from 'vitest';

import {
    planContentGrowthLiveTailPinSchedule,
    planContentGrowthLiveTailScheduledPinFire,
    type ContentGrowthLiveTailScheduledPin,
} from './contentGrowthLiveTailScheduler';

type TestWebMetrics = Readonly<{
    beforeScrollTop: number;
}>;

const scheduledPin = (
    overrides: Partial<ContentGrowthLiveTailScheduledPin<TestWebMetrics>> = {},
): ContentGrowthLiveTailScheduledPin<TestWebMetrics> => ({
    delayMs: 250,
    kind: 'timeout',
    nativePrevFollowAtBottom: false,
    previousWebMetrics: null,
    reason: 'content-size-change',
    ...overrides,
});

describe('content-growth live-tail scheduler owner', () => {
    it('does not schedule a pin when the automatic follow gate blocks it', () => {
        expect(planContentGrowthLiveTailPinSchedule({
            canUseAnimationFrame: true,
            currentScheduled: null,
            nativePrevFollowAtBottom: false,
            platform: 'native',
            previousWebMetrics: null,
            reason: 'content-size-change',
            usesNativeFlashListBottomMaintenance: true,
            waitMs: null,
        })).toEqual({
            reason: 'auto-follow-blocked',
            type: 'skip',
        });
    });

    it('keeps existing scheduled work unless native stream growth supersedes a stale non-stream pin', () => {
        const currentScheduled = scheduledPin({ reason: 'content-size-change' });

        expect(planContentGrowthLiveTailPinSchedule({
            canUseAnimationFrame: true,
            currentScheduled,
            nativePrevFollowAtBottom: false,
            platform: 'native',
            previousWebMetrics: null,
            reason: 'layout-change',
            usesNativeFlashListBottomMaintenance: true,
            waitMs: 0,
        })).toEqual({
            reason: 'existing-scheduled-pin',
            type: 'keep-existing',
        });

        expect(planContentGrowthLiveTailPinSchedule({
            canUseAnimationFrame: true,
            currentScheduled,
            nativePrevFollowAtBottom: true,
            platform: 'native',
            previousWebMetrics: null,
            reason: 'stream-append',
            usesNativeFlashListBottomMaintenance: true,
            waitMs: 0,
        })).toEqual({
            cancelExisting: true,
            pin: {
                delayMs: 0,
                kind: 'raf',
                nativePrevFollowAtBottom: true,
                previousWebMetrics: null,
                reason: 'stream-append',
            },
            reason: 'native-stream-supersedes-stale-pin',
            type: 'schedule',
        });
    });

    it('does not let stream growth supersede an existing stream pin or a web scheduled pin', () => {
        for (const currentScheduled of [
            scheduledPin({ reason: 'stream-append' }),
            scheduledPin({ reason: 'content-size-change' }),
        ]) {
            expect(planContentGrowthLiveTailPinSchedule({
                canUseAnimationFrame: true,
                currentScheduled,
                nativePrevFollowAtBottom: true,
                platform: currentScheduled.reason === 'stream-append' ? 'native' : 'web',
                previousWebMetrics: null,
                reason: 'stream-append',
                usesNativeFlashListBottomMaintenance: true,
                waitMs: 0,
            })).toEqual({
                reason: 'existing-scheduled-pin',
                type: 'keep-existing',
            });
        }
    });

    it('chooses timeout when the gate asks to wait or animation frames are unavailable', () => {
        expect(planContentGrowthLiveTailPinSchedule({
            canUseAnimationFrame: true,
            currentScheduled: null,
            nativePrevFollowAtBottom: false,
            platform: 'web',
            previousWebMetrics: { beforeScrollTop: 12 },
            reason: 'content-size-change',
            usesNativeFlashListBottomMaintenance: false,
            waitMs: 125,
        })).toEqual({
            cancelExisting: false,
            pin: {
                delayMs: 125,
                kind: 'timeout',
                nativePrevFollowAtBottom: false,
                previousWebMetrics: { beforeScrollTop: 12 },
                reason: 'content-size-change',
            },
            reason: 'new-scheduled-pin',
            type: 'schedule',
        });

        expect(planContentGrowthLiveTailPinSchedule({
            canUseAnimationFrame: false,
            currentScheduled: null,
            nativePrevFollowAtBottom: false,
            platform: 'web',
            previousWebMetrics: null,
            reason: 'layout-change',
            usesNativeFlashListBottomMaintenance: false,
            waitMs: 0,
        })).toMatchObject({
            pin: {
                delayMs: 0,
                kind: 'timeout',
                reason: 'layout-change',
            },
            type: 'schedule',
        });
    });

    it('skips a fired pin when automatic follow is no longer ready', () => {
        expect(planContentGrowthLiveTailScheduledPinFire({
            pin: scheduledPin({ reason: 'stream-append' }),
            usesNativeFlashListBottomMaintenance: true,
            waitMs: 250,
        })).toEqual({
            clearScheduled: true,
            effects: [],
            reason: 'auto-follow-not-ready',
            type: 'skip-fire',
        });
    });

    it('plans web adjustment before the generic pin at fire time', () => {
        expect(planContentGrowthLiveTailScheduledPinFire({
            pin: scheduledPin({
                previousWebMetrics: { beforeScrollTop: 42 },
                reason: 'content-size-change',
            }),
            usesNativeFlashListBottomMaintenance: false,
            waitMs: 0,
        })).toEqual({
            clearScheduled: true,
            effects: [
                {
                    previousWebMetrics: { beforeScrollTop: 42 },
                    reason: 'content-size-change',
                    type: 'apply-web-bottom-follow-adjustment',
                },
                {
                    reason: 'content-size-change',
                    type: 'pin-to-bottom',
                },
            ],
            type: 'fire',
        });
    });

    it('plans native measured pin execution with the captured pre-growth follow state', () => {
        expect(planContentGrowthLiveTailScheduledPinFire({
            pin: scheduledPin({
                nativePrevFollowAtBottom: true,
                reason: 'stream-append',
            }),
            usesNativeFlashListBottomMaintenance: true,
            waitMs: 0,
        })).toEqual({
            clearScheduled: true,
            effects: [
                {
                    nativePrevFollowAtBottom: true,
                    reason: 'stream-append',
                    type: 'pin-native-respecting-mount-settle',
                },
            ],
            type: 'fire',
        });
    });
});
