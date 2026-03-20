import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { AgentEvent } from '@/sync/typesRaw';
import { t } from '@/text';

function formatLimitReachedTime(timestamp: number): string {
    try {
        const date = new Date(timestamp * 1000);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return t('message.unknownTime');
    }
}

export const TranscriptEventRow = React.memo(function TranscriptEventRow(props: {
    event: AgentEvent;
}) {
    const { theme } = useUnistyles();
    let iconName: React.ComponentProps<typeof Ionicons>['name'] = 'information-circle-outline';
    let text = t('message.unknownEvent');

    if (props.event.type === 'switch') {
        iconName = 'swap-horizontal-outline';
        text = t('message.switchedToMode', { mode: props.event.mode });
    } else if (props.event.type === 'message') {
        iconName = 'information-circle-outline';
        text = props.event.message;
    } else if (props.event.type === 'limit-reached') {
        iconName = 'warning-outline';
        text = t('message.usageLimitUntil', { time: formatLimitReachedTime(props.event.endsAt) });
    }

    return (
        <View style={styles.container}>
            <View style={styles.row}>
                <View style={styles.iconContainer}>
                    <Ionicons name={iconName} size={18} color={theme.colors.textSecondary} />
                </View>
                <Text selectable style={styles.text}>
                    {text}
                </Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        paddingBottom: 22,
        alignSelf: 'stretch',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
    },
    iconContainer: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    text: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '500',
        flexShrink: 1,
    },
}));
