import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';

export type McpServerBadgeTone = 'default' | 'accent' | 'success' | 'warning';

function resolveMcpServerBadgeVariant(tone: McpServerBadgeTone | undefined): StatusPillVariant {
    switch (tone) {
        case 'success':
            return 'success';
        case 'warning':
            return 'warning';
        case 'accent':
            return 'info';
        case 'default':
        case undefined:
            return 'neutral';
    }
}

export const McpServerBadgePills = React.memo(function McpServerBadgePills(props: Readonly<{
    badges: ReadonlyArray<{ key: string; label: string; tone?: McpServerBadgeTone }>;
    align?: 'start' | 'end';
    size?: 'default' | 'compact';
    testID?: string;
}>) {
    const styles = stylesheet;

    if (props.badges.length === 0) return null;

    return (
        <View style={[
            styles.container,
            props.align === 'start' ? styles.containerStart : styles.containerEnd,
            props.size === 'compact' ? styles.containerCompact : null,
        ]}>
            {props.badges.map((badge) => (
                <StatusPill
                    key={badge.key}
                    testID={props.testID ? `${props.testID}:${badge.key}` : undefined}
                    variant={resolveMcpServerBadgeVariant(badge.tone)}
                    label={badge.label}
                    style={props.size === 'compact' ? styles.badgeCompact : undefined}
                />
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
    badgeCompact: {
        paddingHorizontal: 6,
        paddingVertical: 1,
    },
}));
