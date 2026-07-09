import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Text } from '@/components/ui/text/Text';
import { TRANSCRIPT_BOTTOM_GUTTER_PX } from '@/components/sessions/transcript/_constants';
import { t } from '@/text';

/**
 * Bottom-anchored sibling of {@link
 * '@/components/sessions/transcript/OlderLoadProgressOverlay'.OlderLoadProgressOverlay}.
 *
 * When a background-working session is reopened we show the last-known-good
 * transcript and then silently catch up to newer activity. Without a signal the
 * tail looks static while sync is actually fetching. This overlay surfaces that
 * catch-up at the bottom edge, above the composer — mirroring the top-edge
 * older-load overlay so it never joins the scrollable content geometry and never
 * perturbs the just-stabilized pin-to-bottom.
 *
 * Like the older overlay it is spinner-delayed: a fast catch-up that resolves in
 * under {@link CatchUpProgressOverlayProps.spinnerDelayMs} never flashes. The
 * delay gate is owned here so consumers can pass the raw `isCatchingUp` signal
 * (e.g. from `useSessionCatchingUpNewer`) directly.
 *
 * INTEGRATION NOTE (host owns rendering):
 * - Read the signal with `useSessionCatchingUpNewer(sessionId)` from
 *   `@/sync/store/hooks` (UI-observable, fail-closed) and pass it as `isCatchingUp`.
 * - Pass `spinnerDelayMs={sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs}`
 *   (reuse the existing older-load tuning; do not add a new tuning).
 * - Anchor with `bottomInset` = the composer inset the inverted list already
 *   tracks (the `composerInset` fed to the inverted pin `viewOffset: -composerInset`
 *   via `handleComposerInsetHeightChange`). Do NOT hardcode the offset.
 * - Render it as the last sibling of the list container so it sits ABOVE the
 *   transcript content (zIndex handled here). It is `pointerEvents: 'none'`, so it
 *   never blocks taps on the composer or transcript.
 * - Share this single component across BOTH `ChatList` and `ChainTranscriptList`,
 *   exactly like `OlderLoadProgressOverlay`.
 */
export type CatchUpProgressOverlayProps = Readonly<{
    /** Raw per-session "newer catch-up in flight" signal (host reads + gates this). */
    isCatchingUp: boolean;
    /** Composer inset (px) so the overlay anchors just above the composer. */
    bottomInset: number;
    /** Spinner-delay (ms); reuse `transcriptOlderLoadSpinnerDelayMs`. 0 shows immediately. */
    spinnerDelayMs: number;
}>;

function normalizeDelayMs(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeInset(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export const CatchUpProgressOverlay = React.memo((props: CatchUpProgressOverlayProps) => {
    const { theme } = useUnistyles();
    const { isCatchingUp, bottomInset, spinnerDelayMs } = props;

    // Spinner-delay gate: only reveal once the catch-up has been continuously in
    // flight for `spinnerDelayMs`, so quick reopens never flash.
    const [showSpinner, setShowSpinner] = React.useState(false);

    React.useEffect(() => {
        if (!isCatchingUp) {
            setShowSpinner(false);
            return;
        }
        const delayMs = normalizeDelayMs(spinnerDelayMs);
        if (delayMs <= 0) {
            setShowSpinner(true);
            return;
        }
        let cancelled = false;
        const handle = setTimeout(() => {
            if (!cancelled) setShowSpinner(true);
        }, delayMs);
        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [isCatchingUp, spinnerDelayMs]);

    if (!isCatchingUp || !showSpinner) {
        return null;
    }

    const containerStyle: ViewStyle = {
        alignItems: 'center',
        // Float a fixed gutter ABOVE the composer inset so the glass pill + its
        // cast shadow clear the composer instead of sitting flush against it
        // (mirrors the top-edge older-load overlay's gutter).
        bottom: normalizeInset(bottomInset) + TRANSCRIPT_BOTTOM_GUTTER_PX,
        left: 0,
        position: 'absolute',
        right: 0,
        zIndex: 2,
    };
    // Row layout for the pill contents; the glass surface (rim + soft cast shadow,
    // matching the jump-to-bottom button) is provided by `GlassPanel`.
    const rowStyle: ViewStyle = {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
    };

    return (
        <View
            testID="transcript-catch-up-progress-overlay"
            pointerEvents="none"
            style={containerStyle}
        >
            <GlassPanel shadowLevel={2} innerShadow={false}>
                <View style={rowStyle}>
                    <ActivitySpinner size="small" />
                    <Text style={{ color: theme.colors.text.secondary, fontSize: 13 }}>
                        {t('transcript.progress.catchingUp')}
                    </Text>
                </View>
            </GlassPanel>
        </View>
    );
});
