import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { ThinkingPulseLabel } from '@/components/sessions/transcript/motion/ThinkingPulseLabel';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';

export const ThinkingTimelineRow = React.memo(function ThinkingTimelineRow(props: {
    id: string;
    createdAt: number;
    label: string;
    summary: string;
    expandedByDefault: boolean;
    pulseEnabled: boolean;
    chrome?: 'plain' | 'card';
    icon?: IconName;
    headerTestID?: string;
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
                testID={props.headerTestID ?? 'transcript-thinking-header'}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                aria-expanded={expanded}
                onPress={() => setExpanded(!expanded)}
                style={({ pressed }) => [styles.header, pressed && styles.headerPressed]}
            >
                <View style={styles.labelContainer}>
                    <View style={styles.labelRow}>
                        <View style={styles.labelGutter}>
                            <Icon name={props.icon ?? 'sparkle'} size={16} color={theme.colors.text.secondary} />
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
                    <DisclosureCaret expanded={expanded} size={16} />
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
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s8,
        backgroundColor: theme.colors.input.background,
    },
    containerPlain: {
        paddingVertical: 0,
        paddingHorizontal: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    headerPressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
    labelContainer: {
        flex: 1,
        minWidth: 0,
    },
    labelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        gap: theme.space.s8,
    },
    labelGutter: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    labelText: {
        ...Typography.variant('body', 'semiBold'),
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
        marginLeft: theme.space.s8,
        color: theme.colors.text.secondary,
        fontSize: 13,
        fontStyle: 'italic',
        opacity: 0.95,
    },
    body: {
        marginTop: theme.space.s8,
    },
}));

export default ThinkingTimelineRow;
