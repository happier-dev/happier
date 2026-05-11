import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export type McpServerBadgeTone = 'default' | 'accent' | 'success' | 'warning';

export const McpServerBadgePills = React.memo(function McpServerBadgePills(props: Readonly<{
    badges: ReadonlyArray<{ key: string; label: string; tone?: McpServerBadgeTone }>;
    align?: 'start' | 'end';
    size?: 'default' | 'compact';
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    if (props.badges.length === 0) return null;

    return (
        <View style={[
            styles.container,
            props.align === 'start' ? styles.containerStart : styles.containerEnd,
            props.size === 'compact' ? styles.containerCompact : null,
        ]}>
            {props.badges.map((badge) => (
                <View
                    key={badge.key}
                    style={[
                        styles.badge,
                        props.size === 'compact' ? styles.badgeCompact : null,
                        badge.tone === 'accent' ? styles.badgeAccent : null,
                        badge.tone === 'success' ? styles.badgeSuccess : null,
                        badge.tone === 'warning' ? styles.badgeWarning : null,
                    ]}
                >
                    <Text
                        style={[
                            styles.badgeText,
                            props.size === 'compact' ? styles.badgeTextCompact : null,
                            badge.tone === 'accent' ? { color: theme.colors.accent.blue } : null,
                            badge.tone === 'success' ? { color: theme.colors.state.success.foreground } : null,
                            badge.tone === 'warning' ? { color: theme.colors.accent.purple ?? theme.colors.text.secondary } : null,
                        ]}
                    >
                        {badge.label}
                    </Text>
                </View>
            ))}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
        maxWidth: 220,
    },
    containerStart: {
        justifyContent: 'flex-start',
    },
    containerEnd: {
        justifyContent: 'flex-end',
    },
    containerCompact: {
        gap: 4,
        maxWidth: 260,
    },
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    badgeCompact: {
        paddingHorizontal: 6,
        paddingVertical: 1,
    },
    badgeAccent: {
        backgroundColor: theme.colors.surface.inset,
    },
    badgeSuccess: {
        backgroundColor: theme.colors.surface.inset,
    },
    badgeWarning: {
        backgroundColor: theme.colors.surface.inset,
    },
    badgeText: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    badgeTextCompact: {
        fontSize: 11,
        lineHeight: 14,
    },
}));
