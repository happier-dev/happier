import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeMomentumSettleAwayReleaseInputEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-momentum-settle-away-release-live-tail' }
>;

export type NativeMomentumSettleAwayReleaseStateEffect = Readonly<{
    distanceFromLiveTailPx: number;
    scrollPinEvent: Readonly<{
        enabled: boolean;
        offsetY: number;
        pinnedOffsetThresholdPx: 0;
        type: 'scroll';
    }>;
    sessionId: string;
    type: 'apply-native-momentum-settle-away-release-state';
    viewportState: Readonly<{
        isPinned: false;
        offsetY: number;
        shouldRestoreViewport: true;
    }>;
}>;

export function resolveNativeMomentumSettleAwayReleaseStateEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    pinEnabled: boolean;
    sessionId: string;
    wantsPinned: boolean;
}>): readonly NativeMomentumSettleAwayReleaseStateEffect[] {
    if (!params.wantsPinned) return [];

    const releaseEffect = params.effects.find((
        effect,
    ): effect is NativeMomentumSettleAwayReleaseInputEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'native-momentum-settle-away-release-live-tail'
    ));
    if (!releaseEffect) return [];

    const distanceFromLiveTailPx = releaseEffect.distanceFromLiveTailPx;
    return [{
        distanceFromLiveTailPx,
        scrollPinEvent: {
            enabled: params.pinEnabled,
            offsetY: distanceFromLiveTailPx,
            pinnedOffsetThresholdPx: 0,
            type: 'scroll',
        },
        sessionId: params.sessionId,
        type: 'apply-native-momentum-settle-away-release-state',
        viewportState: {
            isPinned: false,
            offsetY: distanceFromLiveTailPx,
            shouldRestoreViewport: true,
        },
    }];
}
