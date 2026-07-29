import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { useVoiceLabEnergy } from './useVoiceLabEnergy';
import { VOICE_MOTION, light, useVoiceLabTokens } from './voiceLabTokens';
import type { VoiceControlSpec } from './voiceLabModel';

const EASE_LOCAL = Easing.bezier(...(VOICE_MOTION.local.bezier as [number, number, number, number]));

/**
 * A control that acknowledges the press before the work completes.
 *
 * `scale(0.96)` is the standard tactile value; anything below 0.95 reads as
 * exaggerated. The press-in is instant and the release settles, so a cancelled
 * press (finger moved away) returns without ever committing.
 */
export const TactilePressable = React.memo(function TactilePressable(props: Readonly<{
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityLabel: string;
    accessibilityHint?: string;
    disabled?: boolean;
    testID?: string;
    style?: any;
    children: React.ReactNode;
    /** Disable the scale response where movement would be distracting. */
    static?: boolean;
    /**
     * Layout applied to the Pressable itself.
     *
     * `style` lands on the inner animated view, so flex/size rules put there are
     * silently ignored by the parent row — the Pressable still shrinks to its
     * content. Anything that participates in the parent's layout belongs here.
     */
    containerStyle?: any;
}>) {
    const pressed = useSharedValue(0);
    // A pressable must never wrap another pressable: react-native-web renders
    // `accessibilityRole="button"` as a real <button>, so nesting produces
    // invalid DOM and a screen reader that cannot reach the inner control.
    // Concepts therefore keep their controls as siblings of the tap target,
    // never as its children.
    const animated = useAnimatedStyle(() => {
        'worklet';
        if (props.static) return { opacity: 1 - pressed.get() * 0.3 };
        return { transform: [{ scale: 1 - pressed.get() * 0.04 }] };
    });

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            accessibilityState={{ disabled: props.disabled === true }}
            disabled={props.disabled}
            testID={props.testID}
            style={props.containerStyle}
            onPressIn={() => pressed.set(withTiming(1, { duration: 90, easing: EASE_LOCAL }))}
            onPressOut={() => pressed.set(withTiming(0, { duration: 180, easing: EASE_LOCAL }))}
            onPress={props.onPress}
            onLongPress={props.onLongPress}
        >
            <Animated.View style={[props.style, animated]}>{props.children}</Animated.View>
        </Pressable>
    );
});

/**
 * The terminal action.
 *
 * "End Voice" stops the live audio experience; it does not cancel admitted
 * coding work. It is spatially separated and set in the destructive tone, but it
 * gets no warning chrome — a red-filled button here would be false urgency for
 * an action the user takes every single session.
 */
export const TerminalAction = React.memo(function TerminalAction(props: Readonly<{
    label: string;
    onPress: () => void;
}>) {
    const tokens = useVoiceLabTokens();
    return (
        <TactilePressable
            accessibilityLabel={props.label}
            accessibilityHint="Stops the spoken conversation. Coding work already started keeps running."
            onPress={props.onPress}
            // No border, no fill. A terminal action must be intentional and
            // spatially separated, but it is taken every single session — giving
            // it button chrome makes it the loudest object on a surface whose
            // job is to report state.
            style={{
                minHeight: 28,
                justifyContent: 'center',
                paddingHorizontal: 2,
            }}
        >
            <Text style={{ ...Typography.default('semiBold'), fontSize: 12, color: tokens.inkMuted }}>
                {props.label}
            </Text>
        </TactilePressable>
    );
});

/** A quiet secondary action. Text-led, never a circular icon in a row of five. */
export const QuietAction = React.memo(function QuietAction(props: Readonly<{
    label: string;
    onPress: () => void;
    tone?: 'default' | 'primary';
}>) {
    const tokens = useVoiceLabTokens();
    const primary = props.tone === 'primary';
    return (
        <TactilePressable
            accessibilityLabel={props.label}
            onPress={props.onPress}
            style={{
                minHeight: 28,
                justifyContent: 'center',
                paddingHorizontal: primary ? 12 : 8,
                borderRadius: 8,
                backgroundColor: primary ? (tokens.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)') : 'transparent',
            }}
        >
            <Text
                style={{
                    ...Typography.default('semiBold'),
                    fontSize: 12,
                    color: primary ? tokens.ink : tokens.inkMuted,
                }}
            >
                {props.label}
            </Text>
        </TactilePressable>
    );
});

/**
 * Provider + data affordance.
 *
 * This replaces the permanent underlined "Privacy" link. It names the provider
 * that is actually carrying the audio, and opens the data sheet on demand —
 * the disclosure is available at the point of decision without occupying the
 * surface at rest.
 */
export const ProviderAffordance = React.memo(function ProviderAffordance(props: Readonly<{
    label: string;
    onPress: () => void;
}>) {
    const tokens = useVoiceLabTokens();
    return (
        <TactilePressable
            accessibilityLabel={`${props.label}. Provider and data details`}
            accessibilityHint="Opens which provider, account and machine handle this conversation"
            onPress={props.onPress}
            static
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 20, paddingRight: 2 }}
        >
            <Text style={{ ...Typography.default(), fontSize: 11, color: tokens.inkFaint }}>{props.label}</Text>
            <View
                style={{
                    width: 11,
                    height: 11,
                    borderRadius: 11,
                    borderWidth: 1,
                    borderColor: tokens.inkFaint,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Text
                    style={{
                        ...Typography.default('semiBold'),
                        fontSize: 8,
                        lineHeight: 9,
                        color: tokens.inkFaint,
                    }}
                >
                    i
                </Text>
            </View>
        </TactilePressable>
    );
});

/**
 * The transport.
 *
 * This is the thing the first round of concepts was missing: an unmistakable,
 * always-present way to start, stop, and mute. It is deliberately **not** a row
 * of equal circular icons.
 *
 *  - **Primary** — one filled pill. Start when idle, End when live. It is the
 *    only filled element on the surface, so there is never a question about
 *    where the main action is. (The shipped surface paints idle Start with the
 *    *disabled* token at ≈1.8:1; this is the correction.)
 *  - **Mic** — a bordered circle whose muted state is carried by fill, a slash,
 *    *and* the label. In an hours-long companion, "is my microphone open" must
 *    be the single most legible thing on screen, and today it is a glyph swap
 *    with no colour or fill change at all.
 *  - **Contextual** — everything else, quiet, and only when meaningful.
 *
 * There is no Pause. The runtime has no pause state; muting the microphone is
 * the closest truthful thing, and inventing a third transport state would be a
 * lie about what the session is doing.
 */
export const VoiceTransport = React.memo(function VoiceTransport(props: Readonly<{
    /** True when a live session exists. */
    live: boolean;
    /** True when starting is possible at all. */
    canStart: boolean;
    muted: boolean;
    canMute: boolean;
    /** Contextual actions rendered after the transport. */
    extra?: readonly VoiceControlSpec[];
    onStart: () => void;
    onEnd: () => void;
    onToggleMute: () => void;
    onAction: (id: VoiceControlSpec['id']) => void;
    /** Show the text label beside the glyph. Off for the compact status-line form. */
    label?: boolean;
    /** Compact drops labels from the contextual row, never from the transport. */
    compact?: boolean;
}>) {
    const tokens = useVoiceLabTokens();
    const disabled = !props.live && !props.canStart;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <TactilePressable
                accessibilityLabel={props.live ? 'End Voice' : 'Start Voice'}
                accessibilityHint={
                    props.live
                        ? 'Stops the spoken conversation. Coding work already started keeps running.'
                        : 'Starts a spoken conversation'
                }
                disabled={disabled}
                onPress={props.live ? props.onEnd : props.onStart}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 7,
                    height: 34,
                    width: props.label ? undefined : 34,
                    justifyContent: 'center',
                    paddingHorizontal: props.label ? 13 : 0,
                    borderRadius: 999,
                    opacity: disabled ? 0.4 : 1,
                    // The one filled element. Live uses the surface's own light so
                    // the transport belongs to the presence; idle uses ink so it
                    // reads as the primary action even against a dark planet.
                    backgroundColor: props.live
                        ? (tokens.dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.075)')
                        : (tokens.dark ? '#EFEFEF' : '#0A0A0A'),
                }}
            >
                {props.live ? (
                    <View style={{ width: 10, height: 10, borderRadius: 2.5, backgroundColor: tokens.ink }} />
                ) : (
                    <WaveGlyph color={tokens.dark ? '#131111' : '#FFFFFF'} />
                )}
                {props.label ? (
                    <Text
                        style={{
                            ...Typography.default('semiBold'),
                            fontSize: 13,
                            letterSpacing: -0.1,
                            color: props.live ? tokens.ink : (tokens.dark ? '#131111' : '#FFFFFF'),
                        }}
                    >
                        {props.live ? 'End' : 'Start Voice'}
                    </Text>
                ) : null}
            </TactilePressable>

            {props.live && props.canMute ? (
                <TactilePressable
                    accessibilityLabel={props.muted ? 'Microphone muted. Unmute' : 'Microphone open. Mute'}
                    onPress={props.onToggleMute}
                    style={{
                        width: 34,
                        height: 34,
                        borderRadius: 999,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: 1,
                        // Muted is carried by fill AND border AND the glyph slash —
                        // never by a glyph swap alone.
                        borderColor: props.muted
                            ? light('warm', 0.85, tokens)
                            : tokens.rule,
                        backgroundColor: props.muted ? light('warm', 0.16, tokens) : 'transparent',
                    }}
                >
                    <MicGlyph muted={props.muted} color={props.muted ? light('warm', 1, tokens) : tokens.ink} />
                </TactilePressable>
            ) : null}

            {(props.extra ?? []).map((c) => (
                <QuietAction key={c.id} label={c.label} onPress={() => props.onAction(c.id)} />
            ))}
        </View>
    );
});

/**
 * The start glyph is the level meter itself.
 *
 * A play triangle would say "media player"; a waveform says "voice". Grok's
 * composer makes the same call — its centre element is an animated waveform, not
 * a transport icon. Here the bars rest at idle height before a session exists
 * and are driven by the real envelope once one does, so the button is a
 * continuous object rather than an icon that gets swapped out.
 */
const WaveGlyph = React.memo(function WaveGlyph(props: Readonly<{ color: string }>) {
    const energy = useVoiceLabEnergy();
    // Incommensurate phases so the bars never move in lockstep — the same
    // BAR_PHASE trick the shipped visualizer uses.
    // Distinct resting heights: an idle glyph with four equal bars reads as
    // dots, not as voice. Amplitude modulates upward from this silhouette.
    const bars = [
        { rest: 0.42, phase: 0.72 },
        { rest: 1, phase: 1 },
        { rest: 0.66, phase: 0.9 },
        { rest: 0.32, phase: 0.6 },
    ] as const;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 13 }}>
            {bars.map((bar, i) => (
                <WaveBar key={i} rest={bar.rest} phase={bar.phase} color={props.color} energy={energy} />
            ))}
        </View>
    );
});

const WaveBar = React.memo(function WaveBar(props: Readonly<{
    rest: number;
    phase: number;
    color: string;
    energy: ReturnType<typeof useVoiceLabEnergy>;
}>) {
    const animated = useAnimatedStyle(() => {
        'worklet';
        const amp = props.energy.level.get();
        const scaled = props.rest + (1 - props.rest) * Math.min(1, amp * props.phase);
        return { transform: [{ scaleY: scaled }] };
    });
    return (
        <Animated.View
            style={[
                {
                    width: 2.5,
                    height: 13,
                    borderRadius: 2,
                    backgroundColor: props.color,
                    // Bars must grow from a baseline, not about their centre.
                    transformOrigin: 'center',
                },
                animated,
            ]}
        />
    );
});

/** A mic drawn from primitives so the muted slash is a real, animatable object. */
const MicGlyph = React.memo(function MicGlyph(props: Readonly<{ muted: boolean; color: string }>) {
    return (
        <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
            <View
                style={{
                    width: 6,
                    height: 9,
                    borderRadius: 3,
                    backgroundColor: props.color,
                    marginTop: -2,
                }}
            />
            <View
                style={{
                    width: 10,
                    height: 5,
                    borderBottomLeftRadius: 6,
                    borderBottomRightRadius: 6,
                    borderWidth: 1.4,
                    borderTopWidth: 0,
                    borderColor: props.color,
                    marginTop: 1,
                }}
            />
            {props.muted ? (
                <View
                    style={{
                        position: 'absolute',
                        width: 19,
                        height: 1.6,
                        borderRadius: 2,
                        backgroundColor: props.color,
                        transform: [{ rotate: '-45deg' }],
                    }}
                />
            ) : null}
        </View>
    );
});

/**
 * Renders the control set for a state with real weight separation.
 *
 * Primary sits apart from secondary; the terminal action is last and visually
 * distinct without shouting. Controls that are not meaningful in this state are
 * absent, not disabled.
 */
export const ControlRow = React.memo(function ControlRow(props: Readonly<{
    controls: readonly VoiceControlSpec[];
    onAction: (id: VoiceControlSpec['id']) => void;
    /** Hide controls that would be untruthful in a compact presentation. */
    compact?: boolean;
}>) {
    const primary = props.controls.filter((c) => c.weight === 'primary');
    const secondary = props.controls.filter((c) => c.weight === 'secondary');
    const terminal = props.controls.filter((c) => c.weight === 'terminal');
    const visibleSecondary = props.compact ? [] : secondary;

    if (primary.length === 0 && visibleSecondary.length === 0 && terminal.length === 0) return null;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {primary.map((c) => (
                <QuietAction key={c.id} label={c.label} tone="primary" onPress={() => props.onAction(c.id)} />
            ))}
            {visibleSecondary.map((c) => (
                <QuietAction key={c.id} label={c.label} onPress={() => props.onAction(c.id)} />
            ))}
            {terminal.length > 0 ? <View style={{ flex: 1, minWidth: 4 }} /> : null}
            {terminal.map((c) => (
                <TerminalAction key={c.id} label={c.label} onPress={() => props.onAction(c.id)} />
            ))}
        </View>
    );
});
