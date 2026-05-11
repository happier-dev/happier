import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { McpServerBadgePills, type McpServerBadgeTone } from './McpServerBadgePills';

export const McpServerRowSummary = React.memo(function McpServerRowSummary(props: Readonly<{
    primary: string;
    secondary?: string | null;
    badges?: ReadonlyArray<{ key: string; label: string; tone?: McpServerBadgeTone }>;
    primaryUsesItemSubtitle?: boolean;
    badgeSize?: 'default' | 'compact';
}>) {
    if (props.primaryUsesItemSubtitle) {
        return (
            <View style={styles.itemSubtitleContainer}>
                <Text style={styles.itemSubtitle}>{props.primary}</Text>
                {props.secondary ? <Text style={styles.secondary}>{props.secondary}</Text> : null}
                {props.badges && props.badges.length > 0 ? (
                    <McpServerBadgePills badges={props.badges} align="start" size={props.badgeSize} />
                ) : null}
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Text style={styles.primary}>{props.primary}</Text>
            {props.secondary ? <Text style={styles.secondary}>{props.secondary}</Text> : null}
            {props.badges && props.badges.length > 0 ? (
                <McpServerBadgePills badges={props.badges} align="start" size={props.badgeSize} />
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 6,
    },
    itemSubtitleContainer: {
        gap: 4,
    },
    itemSubtitle: {
        ...Typography.default('regular'),
        ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
        color: theme.colors.text.secondary,
    },
    primary: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    secondary: {
        ...Typography.default('regular'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));
