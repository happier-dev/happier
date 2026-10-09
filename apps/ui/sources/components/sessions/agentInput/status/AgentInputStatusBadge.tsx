import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';

import type { AgentInputStatusBadge as AgentInputStatusBadgeDescriptor, AgentInputStatusBadgeTone } from '../agentInputContracts';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Icon } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';

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
    // `paused` reads as a muted, inactive state — the neutral pill, same as `neutral`.
    return 'neutral';
}

export function AgentInputStatusBadge(props: AgentInputStatusBadgeProps) {
    const { theme } = useUnistyles();
    const tone = props.tone ?? 'neutral';
    const emphasis = props.emphasis ?? 'prominent';
    const variant = resolvePillVariant(tone);
    const accent = theme.colors.state[variant].foreground;
    // The state hue lives in the fill and the leading glyph; the label stays in the primary text role
    // (lab `.l12-sb`), which clears AA on every state tint in both themes. Painting the label the accent
    // would read as one colour but measures 2.09:1 on the light warning tint.
    const labelColor = theme.colors.text.primary;
    // A badge that opens a popover says so with the same quiet caret the composer's chips carry.
    const caret = props.renderPopover && emphasis !== 'quiet'
        ? <Icon name="caret-down" size={12} color={theme.colors.text.tertiary} testID={props.testID ? `${props.testID}:caret` : undefined} />
        : undefined;

    const pill = (
        <StatusPill
            variant={variant}
            chrome={emphasis === 'quiet' ? 'plain' : 'pill'}
            // The composer badge is a control among the composer's capsule chips (lab `.l12-sb`), so it takes
            // the capsule shape of that row; the fill, padding owner and type stay the app-wide pill's.
            shape="capsule"
            label={props.label}
            // Composer badges carry sentence-case phrases ("Account rotation pending"), not the
            // 2–8 character tokens the micro-label type is tracked for.
            labelVariant="phrase"
            labelStyle={emphasis === 'quiet' ? undefined : styles.label}
            labelNumberOfLines={props.labelNumberOfLines ?? 1}
            foregroundColor={labelColor}
            leading={props.icon ? props.icon(accent) : undefined}
            trailing={caret}
            hideDot
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
        opacity: motionTokens.press.opacity,
    },
    // Beside the composer's chips the badge keeps their rhythm: a touch more air than a status fact.
    pillDensity: {
        paddingVertical: 4,
        paddingLeft: 8,
        paddingRight: 9,
    },
    label: {
        ...Typography.default('semiBold'),
    },
}));
