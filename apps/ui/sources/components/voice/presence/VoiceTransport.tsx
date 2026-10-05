import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { t } from '@/text';

/**
 * How large the transport is drawn, by the container that hosts it.
 *
 * `pill` — the desktop top-bar capsule: bare glyphs, End in the danger ink.
 * `island` — the floating capsule: round wells, End tinted.
 * `touch` — the phone island: the same wells at touch size inside platform targets.
 */
export type VoiceTransportSize = 'pill' | 'island' | 'touch';

/** `recovery` is the recovery capsule: level with the wells (lab `.tb`), primary fill, round ends. */
const GEOMETRY: Readonly<Record<VoiceTransportSize, Readonly<{ size: number; icon: number; gap: number; recovery: number; recoveryFont: number }>>> = {
    pill: { size: 24, icon: 15, gap: 2, recovery: 22, recoveryFont: 12 },
    island: { size: 32, icon: 16, gap: 6, recovery: 32, recoveryFont: 12.5 },
    touch: { size: 34, icon: 18, gap: 8, recovery: 34, recoveryFont: 13.5 },
};

/**
 * Mute · End — always two separate controls (§4.1, VE-03).
 *
 * Mute never ends and End never mutes. When the attempt carries an admitted recovery (Retry while
 * reconnecting, Allow microphone, Set up) that recovery takes Mute's place and End stays; an attempt
 * that has already failed and can no longer be ended offers recovery and dismissal. Every fact
 * and every handler is the canonical projection's — the transport decides
 * only how to draw them.
 */
export const VoiceTransport = React.memo(function VoiceTransport(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    size: VoiceTransportSize;
    testID?: string;
}>): React.ReactElement | null {
    const { voice, size } = props;
    const geometry = GEOMETRY[size];
    const testID = props.testID ?? 'voice-transport';
    const touchTarget = size === 'touch' ? resolveMinimumInteractiveTargetSize(Platform.OS) : undefined;
    const filled = size !== 'pill';

    const recovery = voice.recoveryAvailable && voice.recoveryLabel
        ? (
            <RoundButton
                testID={`${testID}-recover`}
                size="mini"
                capsuleHeight={geometry.recovery}
                textStyle={{ fontSize: geometry.recoveryFont, lineHeight: Math.round(geometry.recoveryFont * 1.3) }}
                // The short verb (Allow · Retry · Set up) is drawn; the full recovery is its name.
                title={voice.recoveryShortLabel ?? voice.recoveryLabel}
                accessibilityLabel={voice.recoveryLabel}
                onPress={voice.onRecover}
            />
        )
        : null;

    // Terminal failures and clean ends have separate canonical acknowledgements.
    if (!voice.canStop) {
        const onDismiss = voice.canDismissFailedAttempt === true
            ? voice.onDismissFailedAttempt
            : voice.ended ? voice.onDismissEnded : undefined;
        if (recovery && !onDismiss) return <View testID={testID} style={[styles.row, { gap: geometry.gap }]}>{recovery}</View>;
        if (onDismiss) {
            return (
                <View testID={testID} style={[styles.row, { gap: geometry.gap }]}>
                    {recovery}
                    <IconButton
                        testID={`${testID}-dismiss`}
                        iconName="x"
                        accessibilityLabel={t('voicePresence.dismiss')}
                        tooltip={t('voicePresence.dismiss')}
                        size={geometry.size}
                        iconSize={geometry.icon}
                        {...(filled ? { fill: 'neutral' as const } : { variant: 'plain' as const })}
                        minimumInteractiveTargetSize={touchTarget}
                        interactiveTargetGapPx={geometry.gap}
                        onPress={onDismiss}
                    />
                </View>
            );
        }
        return null;
    }

    const muteLabel = voice.muted ? t('voiceSurface.a11y.unmute') : t('voiceSurface.a11y.mute');
    const endLabel = t('voiceAssistant.endVoice');

    return (
        <View testID={testID} style={[styles.row, { gap: geometry.gap }]}>
            {recovery ?? (
                <IconButton
                    testID={`${testID}-mute`}
                    iconName={voice.muted ? 'microphone-slash' : 'microphone'}
                    accessibilityLabel={muteLabel}
                    tooltip={muteLabel}
                    size={geometry.size}
                    iconSize={geometry.icon}
                    {...(filled ? { fill: 'neutral' as const } : { variant: 'plain' as const })}
                    selected={voice.muted}
                    // Stays in place while the call is still opening, so nothing shifts when it lands.
                    disabled={!voice.canMute}
                    minimumInteractiveTargetSize={touchTarget}
                    interactiveTargetGapPx={geometry.gap}
                    onPress={voice.onToggleMute}
                />
            )}
            <IconButton
                testID={`${testID}-end`}
                iconName="phone-hang-up"
                accessibilityLabel={endLabel}
                tooltip={endLabel}
                // While a recovery leads, End steps back to a quiet well (lab STp) so the one action
                // that fixes the call is the one that stands out.
                tone={recovery ? 'default' : 'danger'}
                size={geometry.size}
                iconSize={geometry.icon}
                {...(filled ? { fill: recovery ? 'neutral' as const : 'danger' as const } : { variant: 'plain' as const })}
                minimumInteractiveTargetSize={touchTarget}
                interactiveTargetGapPx={geometry.gap}
                onPress={voice.onToggle}
            />
        </View>
    );
});

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
    },
});
