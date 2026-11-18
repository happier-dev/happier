import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import type { VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';

import { t } from '@/text';

import { VoiceStatusCell } from './VoiceStatusCell';
import { VOICE_STATUS_LINE_METRICS, type VoiceStatusLineSize } from './voiceStatusLineMetrics';
export type { VoiceStatusLineSize } from './voiceStatusLineMetrics';

/** Conversation states in which a call is underway; reconnecting keeps the call it is restoring. */
const CLOCKED_STATES: ReadonlySet<VoiceSurfaceState> = new Set<VoiceSurfaceState>([
    'live', 'listening', 'transcribing', 'thinking', 'speaking', 'interrupted', 'reconnecting',
]);

/** A running-call clock is the same fact in a compact status and a glance header. */
export function readVoiceElapsedStartedAt(
    voice: Pick<VoiceAttemptControlProjection, 'live' | 'tone' | 'surfaceState' | 'elapsedStartedAt'>,
): number | null {
    return voice.live && voice.tone !== 'error' && CLOCKED_STATES.has(voice.surfaceState)
        ? voice.elapsedStartedAt
        : null;
}

/** The elapsed clock: `m:ss`, growing to `h:mm:ss` only when a conversation runs that long. */
export function formatVoiceElapsed(totalSeconds: number): string {
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const ss = seconds.toString().padStart(2, '0');
    return hours > 0 ? `${hours}:${minutes.toString().padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/**
 * The status word · its dot cell · the elapsed time (§4.1).
 *
 * The word is the canonical status presenter's; colour only repeats what the word already says
 * (attention amber, failure red). The clock is anchored on the runtime's admitted start fact and
 * ticks in its own leaf, so the second hand never re-renders the container around it.
 */
export const VoiceStatusLine = React.memo(function VoiceStatusLine(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    size: VoiceStatusLineSize;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const metrics = VOICE_STATUS_LINE_METRICS[props.size];
    // The clock says a call is running: only while one is underway, never while it is still
    // opening, blocked or failed (lab ST).
    const startedAt = readVoiceElapsedStartedAt(props.voice);
    const ended = !props.voice.live ? props.voice.ended ?? null : null;
    const endedSeconds = ended && ended.startedAt !== null
        ? Math.max(0, Math.round((ended.endedAt - ended.startedAt) / 1000))
        : null;
    const cell = props.voice.statusCell;
    const wordColor = props.voice.tone === 'error'
        ? theme.colors.state.danger.textForeground
        : cell === 'needs_you'
            ? theme.colors.state.warning.textForeground
            : theme.colors.text.primary;
    const hero = props.size === 'hero';
    return (
        <View testID={props.testID ?? 'voice-status-line'} style={[styles.row, { gap: metrics.gap }]}>
            <Text
                accessibilityLabel={props.voice.statusLabel}
                numberOfLines={1}
                style={[
                    hero ? styles.wordHero : styles.word,
                    { fontSize: metrics.fontSize, lineHeight: metrics.lineHeight, color: wordColor },
                ]}
            >
                {props.voice.statusWord}
            </Text>
            {cell ? <VoiceStatusCell kind={cell} size={hero ? 18 : 14} /> : null}
            {startedAt !== null && !hero ? (
                <VoiceElapsed startedAt={startedAt} fontSize={metrics.fontSize} lineHeight={metrics.lineHeight} />
            ) : null}
            {props.size === 'pill' && props.voice.awaitingSend ? (
                // The pill has no caption line, so the next step rides the status line; it gives way first.
                <Text numberOfLines={1} style={[styles.nextStep, { fontSize: metrics.fontSize, lineHeight: metrics.lineHeight }]}>
                    {t('voicePresence.captions.listeningSend')}
                </Text>
            ) : null}
            {endedSeconds !== null && !hero ? (
                // The ended call's length, still: it was measured, it no longer ticks.
                <Text numberOfLines={1} style={[styles.elapsed, { fontSize: metrics.fontSize, lineHeight: metrics.lineHeight }]}>
                    {formatVoiceElapsed(endedSeconds)}
                </Text>
            ) : null}
        </View>
    );
});

/** The ticking leaf. Mounted only while a start fact exists, so a still status line schedules nothing. */
export const VoiceElapsed = React.memo(function VoiceElapsed(props: Readonly<{
    startedAt: number;
    fontSize?: number;
    lineHeight?: number;
}>): React.ReactElement {
    const elapsed = useElapsedTime(props.startedAt);
    return (
        <Text
            numberOfLines={1}
            style={[styles.elapsed, props.fontSize ? { fontSize: props.fontSize, lineHeight: props.lineHeight } : null]}
        >
            {formatVoiceElapsed(elapsed)}
        </Text>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
    },
    // In a capsule the state word never truncates ("Microph…" says nothing); the caption line
    // beneath is what gives way when the capsule is tight.
    word: {
        ...Typography.default('semiBold'),
        flexShrink: 0,
    },
    wordHero: {
        ...Typography.default('bold'),
        letterSpacing: -0.17,
        flexShrink: 1,
    },
    nextStep: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    elapsed: {
        ...Typography.tabular(),
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 0,
    },
}));
