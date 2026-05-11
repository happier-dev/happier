import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { ThinkingPulseLabel } from '@/components/sessions/transcript/motion/ThinkingPulseLabel';
import { Typography } from '@/constants/Typography';

export const ThinkingTimelineRow = React.memo(function ThinkingTimelineRow(props: {
    id: string;
    createdAt: number;
    label: string;
    summary: string;
    expandedByDefault: boolean;
    pulseEnabled: boolean;
    chrome?: 'plain' | 'card';
    expanded?: boolean;
    onExpandedChange?: (next: boolean) => void;
    children?: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const [uncontrolledExpanded, setUncontrolledExpanded] = React.useState<boolean>(props.expandedByDefault);

    const expanded = props.expanded ?? uncontrolledExpanded;
    const setExpanded = props.onExpandedChange ?? setUncontrolledExpanded;
    const chrome: 'plain' | 'card' = props.chrome === 'plain' ? 'plain' : 'card';
    const summaryWithEllipsis = React.useMemo(() => {
        const summary = (props.summary ?? '').trim();
        if (!summary) return '';
        if (summary.endsWith('…') || summary.endsWith('...')) return summary;
        return `${summary}…`;
    }, [props.summary]);

    return (
        <View style={[styles.container, chrome === 'plain' ? styles.containerPlain : styles.containerCard]}>
            <Pressable
                testID="transcript-thinking-header"
                onPress={() => setExpanded(!expanded)}
                style={({ pressed }) => [styles.header, pressed && styles.headerPressed]}
            >
                <View style={styles.labelContainer}>
                    <View style={styles.labelRow}>
                        <View style={styles.labelGutter}>
                            <Ionicons name="sparkles-outline" size={16} color={theme.colors.text.secondary} />
                        </View>
                        <ThinkingPulseLabel
                            label={props.label}
                            enabled={props.pulseEnabled}
                            style={styles.labelText}
                        />
                        {!expanded && summaryWithEllipsis ? (
                            <Text
                                testID="transcript-thinking-summary-inline"
                                style={styles.summaryInline}
                                numberOfLines={1}
                            >
                                {summaryWithEllipsis}
                            </Text>
                        ) : null}
                    </View>
                </View>
                <View style={styles.headerRight}>
                    <Ionicons
                        name={expanded ? 'chevron-up-outline' : 'chevron-down-outline'}
                        size={16}
                        color={theme.colors.text.secondary}
                    />
                </View>
            </Pressable>

            {expanded ? (
                <View style={styles.body}>
                    {props.children}
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        // Common layout for both chrome modes.
        marginTop: 0,
        width: '100%',
        alignSelf: 'stretch',
    },
    containerCard: {
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: theme.colors.input.background,
    },
    containerPlain: {
        paddingVertical: 0,
        paddingHorizontal: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerPressed: {
        opacity: 0.92,
    },
    labelContainer: {
        flex: 1,
        minWidth: 0,
    },
    labelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        gap: 8,
    },
    labelGutter: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    labelText: {
        fontSize: 13,
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    headerRight: {
        width: 18,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    summaryInline: {
        flex: 1,
        minWidth: 0,
        marginLeft: 8,
        color: theme.colors.text.secondary,
        fontSize: 13,
        fontStyle: 'italic',
        opacity: 0.95,
    },
    body: {
        marginTop: 8,
    },
}));

export default ThinkingTimelineRow;
