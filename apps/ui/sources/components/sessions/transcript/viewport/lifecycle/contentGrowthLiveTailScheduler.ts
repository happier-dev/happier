import type { TranscriptViewportScrollReason } from '../transcriptViewportTypes';

export type ContentGrowthLiveTailSchedulerPlatform = 'native' | 'web';

export type ContentGrowthLiveTailScheduledPin<PreviousWebMetrics = unknown> = Readonly<{
    delayMs: number;
    kind: 'raf' | 'timeout';
    nativePrevFollowAtBottom: boolean;
    previousWebMetrics: PreviousWebMetrics | null;
    reason: TranscriptViewportScrollReason;
}>;

export type ContentGrowthLiveTailPinScheduleInput<PreviousWebMetrics = unknown> = Readonly<{
    canUseAnimationFrame: boolean;
    currentScheduled: Pick<ContentGrowthLiveTailScheduledPin<PreviousWebMetrics>, 'reason'> | null;
    nativePrevFollowAtBottom: boolean;
    platform: ContentGrowthLiveTailSchedulerPlatform;
    previousWebMetrics: PreviousWebMetrics | null;
    reason: TranscriptViewportScrollReason;
    usesNativeFlashListBottomMaintenance: boolean;
    waitMs: number | null;
}>;

export type ContentGrowthLiveTailPinScheduleDecision<PreviousWebMetrics = unknown> =
    | Readonly<{
        reason: 'auto-follow-blocked';
        type: 'skip';
    }>
    | Readonly<{
        reason: 'existing-scheduled-pin';
        type: 'keep-existing';
    }>
    | Readonly<{
        cancelExisting: boolean;
        pin: ContentGrowthLiveTailScheduledPin<PreviousWebMetrics>;
        reason: 'native-stream-supersedes-stale-pin' | 'new-scheduled-pin';
        type: 'schedule';
    }>;

export type ContentGrowthLiveTailScheduledPinFireEffect<PreviousWebMetrics = unknown> =
    | Readonly<{
        previousWebMetrics: PreviousWebMetrics;
        reason: TranscriptViewportScrollReason;
        type: 'apply-web-bottom-follow-adjustment';
    }>
    | Readonly<{
        nativePrevFollowAtBottom: boolean;
        reason: TranscriptViewportScrollReason;
        type: 'pin-native-respecting-mount-settle';
    }>
    | Readonly<{
        reason: TranscriptViewportScrollReason;
        type: 'pin-to-bottom';
    }>;

export type ContentGrowthLiveTailScheduledPinFireInput<PreviousWebMetrics = unknown> = Readonly<{
    pin: ContentGrowthLiveTailScheduledPin<PreviousWebMetrics>;
    usesNativeFlashListBottomMaintenance: boolean;
    waitMs: number | null;
}>;

export type ContentGrowthLiveTailScheduledPinFireDecision<PreviousWebMetrics = unknown> =
    | Readonly<{
        clearScheduled: true;
        effects: readonly [];
        reason: 'auto-follow-not-ready';
        type: 'skip-fire';
    }>
    | Readonly<{
        clearScheduled: true;
        effects: readonly ContentGrowthLiveTailScheduledPinFireEffect<PreviousWebMetrics>[];
        type: 'fire';
    }>;

export function planContentGrowthLiveTailPinSchedule<PreviousWebMetrics = unknown>(
    input: ContentGrowthLiveTailPinScheduleInput<PreviousWebMetrics>,
): ContentGrowthLiveTailPinScheduleDecision<PreviousWebMetrics> {
    if (input.waitMs === null) {
        return {
            reason: 'auto-follow-blocked',
            type: 'skip',
        };
    }

    const shouldSupersedeStaleNativePin =
        input.currentScheduled !== null &&
        input.platform === 'native' &&
        input.usesNativeFlashListBottomMaintenance &&
        input.reason === 'stream-append' &&
        input.currentScheduled.reason !== 'stream-append';

    if (input.currentScheduled !== null && !shouldSupersedeStaleNativePin) {
        return {
            reason: 'existing-scheduled-pin',
            type: 'keep-existing',
        };
    }

    const delayMs = Math.max(0, input.waitMs);
    return {
        cancelExisting: shouldSupersedeStaleNativePin,
        pin: {
            delayMs,
            kind: delayMs === 0 && input.canUseAnimationFrame ? 'raf' : 'timeout',
            nativePrevFollowAtBottom: input.nativePrevFollowAtBottom,
            previousWebMetrics: input.previousWebMetrics,
            reason: input.reason,
        },
        reason: shouldSupersedeStaleNativePin ? 'native-stream-supersedes-stale-pin' : 'new-scheduled-pin',
        type: 'schedule',
    };
}

export function planContentGrowthLiveTailScheduledPinFire<PreviousWebMetrics = unknown>(
    input: ContentGrowthLiveTailScheduledPinFireInput<PreviousWebMetrics>,
): ContentGrowthLiveTailScheduledPinFireDecision<PreviousWebMetrics> {
    if (input.waitMs !== 0) {
        return {
            clearScheduled: true,
            effects: [],
            reason: 'auto-follow-not-ready',
            type: 'skip-fire',
        };
    }

    const effects: ContentGrowthLiveTailScheduledPinFireEffect<PreviousWebMetrics>[] = [];
    if (input.pin.previousWebMetrics !== null) {
        effects.push({
            previousWebMetrics: input.pin.previousWebMetrics,
            reason: input.pin.reason,
            type: 'apply-web-bottom-follow-adjustment',
        });
    }
    effects.push(input.usesNativeFlashListBottomMaintenance
        ? {
            nativePrevFollowAtBottom: input.pin.nativePrevFollowAtBottom,
            reason: input.pin.reason,
            type: 'pin-native-respecting-mount-settle',
        }
        : {
            reason: input.pin.reason,
            type: 'pin-to-bottom',
        });

    return {
        clearScheduled: true,
        effects,
        type: 'fire',
    };
}
