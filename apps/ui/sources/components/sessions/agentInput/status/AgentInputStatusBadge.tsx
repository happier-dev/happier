import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { AgentInputStatusBadge as AgentInputStatusBadgeDescriptor, AgentInputStatusBadgeTone } from '../agentInputContracts';

type AgentInputStatusBadgeProps = AgentInputStatusBadgeDescriptor & Readonly<{
    anchorRef?: React.RefObject<any>;
}>;

type ToneTokens = Readonly<{
    background: string;
    border: string;
    foreground: string;
}>;

function resolveToneTokens(theme: ReturnType<typeof useUnistyles>['theme'], tone: AgentInputStatusBadgeTone): ToneTokens {
    if (tone === 'active') {
        return {
            background: theme.colors.state.info.background,
            border: theme.colors.state.info.border,
            foreground: theme.colors.text.primary,
        };
    }
    if (tone === 'paused') {
        return {
            background: theme.colors.state.neutral.background,
            border: theme.colors.state.neutral.border,
            foreground: theme.colors.text.secondary,
        };
    }
    if (tone === 'warning') {
        return {
            background: theme.colors.state.warning.background,
            border: theme.colors.state.warning.border,
            foreground: theme.colors.text.primary,
        };
    }
    if (tone === 'complete') {
        return {
            background: theme.colors.state.success.background,
            border: theme.colors.state.success.border,
            foreground: theme.colors.text.primary,
        };
    }
    return {
        background: theme.colors.surface.elevated,
        border: theme.colors.border.default,
        foreground: theme.colors.text.secondary,
    };
}

export function AgentInputStatusBadge(props: AgentInputStatusBadgeProps) {
    const { theme } = useUnistyles();
    const tone = props.tone ?? 'neutral';
    const emphasis = props.emphasis ?? 'prominent';
    const tokens = resolveToneTokens(theme, tone);
    const content = (pressed: boolean) => (
        <View
            style={[
                styles.badge,
                emphasis === 'quiet' && styles.quietBadge,
                {
                    backgroundColor: emphasis === 'quiet'
                        ? 'transparent'
                        : pressed && props.onPress ? theme.colors.surface.pressed : tokens.background,
                    borderColor: emphasis === 'quiet' ? 'transparent' : tokens.border,
                },
            ]}
        >
            {props.icon ? (
                <View style={styles.icon}>
                    {props.icon(tokens.foreground)}
                </View>
            ) : null}
            <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[styles.label, { color: tokens.foreground }]}
            >
                {props.label}
            </Text>
        </View>
    );

    if (!props.onPress) {
        return (
            <View
                ref={props.anchorRef}
                testID={props.testID}
                accessibilityLabel={props.accessibilityLabel}
                style={styles.wrapper}
            >
                {content(false)}
            </View>
        );
    }

    return (
        <Pressable
            ref={props.anchorRef}
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            onPress={props.onPress}
            style={styles.wrapper}
        >
            {({ pressed }) => content(Boolean(pressed))}
        </Pressable>
    );
}

const styles = StyleSheet.create(() => ({
    wrapper: {
        maxWidth: '70%',
        flexShrink: 1,
    },
    badge: {
        minHeight: 22,
        borderRadius: 6,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 8,
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
    },
    quietBadge: {
        borderWidth: 0,
        paddingHorizontal: 2,
    },
    icon: {
        marginRight: 5,
    },
    label: {
        fontSize: 11,
        ...Typography.default(),
        flexShrink: 1,
    },
}));
