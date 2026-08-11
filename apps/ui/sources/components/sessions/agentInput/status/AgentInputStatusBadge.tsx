import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';

import type { AgentInputStatusBadge as AgentInputStatusBadgeDescriptor, AgentInputStatusBadgeTone } from '../agentInputContracts';

type AgentInputStatusBadgeProps = AgentInputStatusBadgeDescriptor & Readonly<{
    anchorRef?: React.RefObject<any>;
}>;

/**
 * Composer status tones map onto the app-wide pill variants; `StatusPill` owns the chrome (fill,
 * radius, padding, label type) so composer badges cannot drift from every other pill in the app.
 */
function resolvePillVariant(tone: AgentInputStatusBadgeTone): StatusPillVariant {
    if (tone === 'active') return 'info';
    if (tone === 'complete') return 'success';
    if (tone === 'warning') return 'warning';
    if (tone === 'danger') return 'danger';
    // `paused` reads as a muted, inactive state — the neutral pill, same as `neutral`.
    return 'neutral';
}

export function AgentInputStatusBadge(props: AgentInputStatusBadgeProps) {
    const { theme } = useUnistyles();
    const tone = props.tone ?? 'neutral';
    const emphasis = props.emphasis ?? 'prominent';
    const variant = resolvePillVariant(tone);
    const accent = theme.colors.state[variant].foreground;
    // The state hue lives in the fill and the leading glyph; the label stays in a neutral text role.
    // Painting the label the accent too would read as one colour but measures 2.09:1 on the light
    // warning tint — under half the 4.5:1 AA floor for 11px text.
    //
    // Between the two neutral roles, the muted one is the calmer choice but only survives on light:
    // `text.secondary` measures 4.96:1 light / 3.46:1 dark on that same tint. Dark themes need
    // brighter ink to sit equally quiet, so each side takes the most recessive role that still
    // clears AA.
    const labelColor = theme.dark === true
        ? theme.colors.text.primary
        : theme.colors.text.secondary;

    const pill = (
        <StatusPill
            testID={props.testID ? `${props.testID}:pill` : undefined}
            variant={variant}
            chrome={emphasis === 'quiet' ? 'plain' : 'pill'}
            label={props.label}
            // Composer badges carry sentence-case phrases ("Account rotation pending"), not the
            // 2–8 character tokens the micro-label type is tracked for.
            labelVariant="phrase"
            labelNumberOfLines={1}
            foregroundColor={labelColor}
            leading={props.icon ? props.icon(accent) : undefined}
            hideDot
            // Chrome (fill, radius, type, no border) stays the app-wide pill; only the vertical
            // rhythm is local. The composer status row sits beside 11px text and interactive
            // chips, where the pill's default 2px vertical padding reads squat around a glyph.
            style={emphasis === 'quiet' ? undefined : styles.pillDensity}
        />
    );

    if (!props.onPress) {
        return (
            <View
                ref={props.anchorRef}
                testID={props.testID}
                accessibilityLabel={props.accessibilityLabel}
                accessibilityHint={props.accessibilityHint}
                accessibilityState={props.accessibilityState}
                style={styles.wrapper}
            >
                {pill}
            </View>
        );
    }

    return (
        <Pressable
            ref={props.anchorRef}
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            accessibilityHint={props.accessibilityHint}
            accessibilityState={props.accessibilityState}
            // The pill is short; a symmetric slop brings it up to a comfortable target without
            // inflating a control that shares a row with plain 11px status text.
            hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
            onPress={props.onPress}
            style={({ pressed }) => [styles.wrapper, pressed ? styles.wrapperPressed : null]}
        >
            {pill}
        </Pressable>
    );
}

const styles = StyleSheet.create(() => ({
    wrapper: {
        maxWidth: '70%',
        flexShrink: 1,
    },
    wrapperPressed: {
        opacity: 0.6,
    },
    pillDensity: {
        paddingVertical: 4,
    },
}));
