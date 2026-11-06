import * as React from 'react';
import type { VoiceTransportProps } from '@happier-dev/plugin-ui';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { t } from '@/text';

import { VoiceReadAloudStop, type VoiceReadAloud } from './VoiceReadAloud';

/**
 * How large the transport is drawn, by the container that hosts it.
 *
 * `pill` — the desktop top-bar capsule: bare glyphs, End in the danger ink.
 * `island` — the floating capsule: round wells, End tinted.
 * `touch` — the retained external-plugin tier; its hit area, not its drawing, reaches the touch floor.
 * `glance` — the Voice glance (Companion and popovers): labelled pills, with the turn's own controls.
 * `sheet` — the phone sheet: the labelled pills share the row's full width.
 */
export type VoiceTransportSize = VoiceTransportProps['size'] | 'glance' | 'sheet';

/** The turn's own controls, beside Mute and End where the transport is labelled. */
export type VoiceTransportTurn = Readonly<{
    canBargeIn: boolean;
    onBargeIn: () => unknown;
    canCancelTurn: boolean;
    onCancelTurn: () => unknown;
}>;

/** `recovery` is the recovery capsule: level with the wells (lab `.tb`), primary fill, round ends. */
const GEOMETRY: Readonly<Record<VoiceTransportProps['size'], Readonly<{ size: number; icon: number; gap: number; recovery: number; recoveryFont: number }>>> = {
    pill: { size: 24, icon: 15, gap: 2, recovery: 22, recoveryFont: 12 },
    island: { size: 32, icon: 16, gap: 6, recovery: 32, recoveryFont: 12.5 },
    touch: { size: 34, icon: 18, gap: 8, recovery: 34, recoveryFont: 13.5 },
};

const LABELLED_GEOMETRY = {
    glance: { button: 'small', icon: 14 },
    sheet: { button: 'normal', icon: 18 },
} as const;
/** Narrowest glance row (px) that holds Unmute · Send · End as labelled pills; between the Companion column (~232) and the phone row (~282). */
const LABELLED_MIN_WIDTH = 260;
/** The compact Mute well matches the small pills' height, so the row stays level. */
const COMPACT_WELL_SIZE = 26;

/**
 * The transport rule (§4.1, VE-03), decided once for every size: Mute never ends and End never mutes.
 * An admitted recovery (Retry while reconnecting, Allow microphone, Set up) takes Mute's place and End
 * stays; an attempt that can no longer be ended offers its recovery and its dismissal.
 */
function resolveVoiceTransportControls(voice: VoiceAttemptControlProjection) {
    const recovery = voice.recoveryAvailable && voice.recoveryLabel ? voice.recoveryLabel : null;
    if (!voice.canStop) {
        // Terminal failures and clean ends have separate canonical acknowledgements.
        const dismiss = voice.canDismissFailedAttempt === true
            ? voice.onDismissFailedAttempt
            : voice.ended ? voice.onDismissEnded : undefined;
        return { recovery, mute: false, end: false, dismiss };
    }
    return { recovery, mute: recovery === null, end: true, dismiss: undefined };
}

/**
 * Mute · End — always two separate controls, drawn at the size of the container that hosts them.
 * Every fact and every handler is the canonical projection's; the transport decides only how to
 * draw them. The labelled sizes also carry the turn's own controls (Send, Interrupt, Cancel reply).
 */
export const VoiceTransport = React.memo(function VoiceTransport(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    size: VoiceTransportSize;
    /** Read-aloud running during a call: its Stop leads, so stopping the reading never ends the call. */
    readAloud?: VoiceReadAloud;
    /** Labelled sizes: Interrupt and Cancel reply, from the surface model. */
    turn?: VoiceTransportTurn;
    /** `glance`: assume the narrow row (Mute as its icon well) until the row has measured itself. */
    narrowByDefault?: boolean;
    testID?: string;
}>): React.ReactElement | null {
    const { voice, size } = props;
    const testID = props.testID ?? 'voice-transport';
    if (size === 'glance' || size === 'sheet') {
        return <VoiceTransportLabelled voice={voice} size={size} turn={props.turn} narrowByDefault={props.narrowByDefault} testID={testID} />;
    }
    const controls = resolveVoiceTransportControls(voice);
    const readAloudStop = props.readAloud && props.readAloud.phase !== 'idle' && size !== 'touch'
        ? <VoiceReadAloudStop readAloud={props.readAloud} size={size} testID={`${testID}-read-aloud-stop`} />
        : null;
    const geometry = GEOMETRY[size];
    const filled = size !== 'pill';

    const recovery = controls.recovery
        ? (
            <RoundButton
                testID={`${testID}-recover`}
                size="mini"
                capsuleHeight={geometry.recovery}
                textStyle={{ fontSize: geometry.recoveryFont, lineHeight: Math.round(geometry.recoveryFont * 1.3) }}
                // One label (Allow · Retry · Set up), drawn and announced alike.
                title={controls.recovery}
                onPress={voice.onRecover}
            />
        )
        : null;
    const dismiss = controls.dismiss ? (
        <IconButton
            testID={`${testID}-dismiss`}
            iconName="x"
            accessibilityLabel={t('voicePresence.dismiss')}
            tooltip={t('voicePresence.dismiss')}
            size={geometry.size}
            iconSize={geometry.icon}
            {...(filled ? { fill: 'neutral' as const } : { variant: 'plain' as const })}
            interactiveTargetGapPx={geometry.gap}
            onPress={controls.dismiss}
        />
    ) : null;
    if (!controls.end) {
        if (!recovery && !dismiss) return null;
        return <View testID={testID} style={[styles.row, { gap: geometry.gap }]}>{recovery}{dismiss}</View>;
    }

    const muteLabel = voice.muted ? t('voiceSurface.a11y.unmute') : t('voiceSurface.a11y.mute');
    const endLabel = t('voiceAssistant.endVoice');

    return (
        <View testID={testID} style={[styles.row, { gap: geometry.gap }]}>
            {readAloudStop}
            {recovery}
            {controls.mute ? (
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
                    interactiveTargetGapPx={geometry.gap}
                    onPress={voice.onToggleMute}
                />
            ) : null}
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
                interactiveTargetGapPx={geometry.gap}
                onPress={voice.onToggle}
            />
        </View>
    );
});

/**
 * The labelled transport (glance and sheet): the same rule as labelled pills, plus Send for buffered
 * input and the turn's Interrupt or Cancel reply. The glance row wraps rather than clipping; below
 * `LABELLED_MIN_WIDTH` of its own measured width Mute steps down to its icon well so the row keeps one
 * line. On the sheet every control shares the row's full width.
 */
const VoiceTransportLabelled = React.memo(function VoiceTransportLabelled(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    size: 'glance' | 'sheet';
    turn?: VoiceTransportTurn;
    narrowByDefault?: boolean;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const { voice, turn, testID } = props;
    const sheet = props.size === 'sheet';
    const { button, icon } = LABELLED_GEOMETRY[props.size];
    const controls = resolveVoiceTransportControls(voice);
    const [rowWidth, setRowWidth] = React.useState<number | null>(null);
    const onRowLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setRowWidth((current) => (current === next ? current : next));
    }, []);
    const compact = !sheet && (rowWidth === null ? props.narrowByDefault === true : rowWidth < LABELLED_MIN_WIDTH);
    const control = sheet ? styles.sheetControl : undefined;
    const glyph = (name: IconName, color: string = theme.colors.text.secondary) => <Icon name={name} size={icon} color={color} />;
    const secondary = (key: string, title: string, iconName: IconName, onPress: () => unknown, accessibilityLabel?: string) => (
        <RoundButton
            testID={`${testID}-${key}`}
            display="secondary"
            size={button}
            style={control}
            title={title}
            accessibilityLabel={accessibilityLabel}
            onPress={() => { void onPress(); }}
            leading={glyph(iconName)}
        />
    );
    const muteLabel = voice.muted ? t('voiceSurface.a11y.unmute') : t('voiceSurface.a11y.mute');

    const recovery = controls.recovery ? (
        <RoundButton
            testID={`${testID}-recover`}
            size={button}
            style={control}
            title={controls.recovery}
            onPress={voice.onRecover}
            leading={voice.recoveryIcon ? glyph(voice.recoveryIcon, theme.colors.button.primary.tint) : undefined}
        />
    ) : null;
    const mute = !controls.mute ? null : compact ? (
        // The same icon-only Mute the island and pill draw: a labelled well with a tooltip.
        <IconButton
            testID={`${testID}-mute`}
            iconName={voice.muted ? 'microphone-slash' : 'microphone'}
            accessibilityLabel={muteLabel}
            tooltip={muteLabel}
            size={COMPACT_WELL_SIZE}
            iconSize={icon}
            selected={voice.muted}
            disabled={!voice.canMute}
            onPress={voice.onToggleMute}
        />
    ) : (
        <RoundButton
            testID={`${testID}-mute`}
            display="secondary"
            size={button}
            style={control}
            disabled={!voice.canMute}
            title={voice.muted ? t('voicePresence.unmute') : t('voicePresence.mute')}
            accessibilityLabel={muteLabel}
            onPress={voice.onToggleMute}
            leading={glyph(voice.muted ? 'microphone-slash' : 'microphone')}
        />
    );
    const send = voice.canCommitInput && voice.commitInputLabel && voice.onCommitInput
        ? secondary('send', voice.commitInputLabel, 'arrow-up', voice.onCommitInput)
        : null;
    const interrupt = turn?.canBargeIn ? secondary('interrupt', t('voicePresence.interrupt'), 'hand', turn.onBargeIn) : null;
    // A reply can be cancelled without ending the call (thinking, or speaking without barge-in).
    const cancelReply = turn?.canCancelTurn && !turn.canBargeIn
        ? secondary('cancel-reply', t('voiceSurface.a11y.cancelTurn'), 'stop', turn.onCancelTurn)
        : null;
    const end = controls.end ? (
        <RoundButton
            testID={`${testID}-end`}
            display="destructive"
            size={button}
            style={sheet ? control : styles.endTrailing}
            title={t('voicePresence.end')}
            accessibilityLabel={t('voiceAssistant.endVoice')}
            onPress={voice.onToggle}
            leading={<Icon name="phone-hang-up" size={icon} color={theme.colors.state.danger.foreground} weight="fill" />}
        />
    ) : null;
    const dismiss = controls.dismiss ? secondary('dismiss', t('voicePresence.dismiss'), 'x', controls.dismiss) : null;
    return (
        <View testID={testID} onLayout={onRowLayout} style={[styles.labelled, sheet ? styles.labelledSheet : null]}>
            {recovery}
            {mute}
            {send}
            {interrupt}
            {cancelReply}
            {end}
            {dismiss}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
    },
    // Wraps instead of clipping: the Companion column is narrower than the popover, and Send adds a third control.
    labelled: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    labelledSheet: { gap: theme.space.s8 },
    // Lab `.vo-sheet .vo-cb`: on the sheet the row's controls share its full width.
    sheetControl: { flex: 1 },
    endTrailing: { marginLeft: 'auto' },
}));
