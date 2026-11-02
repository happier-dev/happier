import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type RowStatusTone = 'quiet' | 'warn' | 'bad';

/**
 * The one status line under a row's title (an agent, an installable provider). Healthy states are quiet
 * text; only trouble carries a dot and a tone (needs you, failed); work in progress leads with a small
 * spinner. A line may end with its one next step (Install, Try again) as an inline link.
 */
export const RowStatusLine = React.memo(function RowStatusLine(props: Readonly<{
    text: string;
    tone: RowStatusTone;
    busy?: boolean;
    action?: Readonly<{ label: string; onPress: () => unknown; testID?: string }> | null;
    testID?: string;
    /** Cards allow two lines; rows keep one. */
    numberOfLines?: number;
}>) {
    const { theme } = useUnistyles();
    const toneColor = props.tone === 'warn'
        ? theme.colors.state.warning.foreground
        : props.tone === 'bad'
            ? theme.colors.state.danger.foreground
            : theme.colors.text.secondary;
    const line = (
        <View testID={props.action ? undefined : props.testID} style={styles.line} accessible={!props.action} accessibilityLabel={props.action ? undefined : props.text}>
            {props.busy ? <ActivitySpinner size={12} color={theme.colors.text.tertiary} style={styles.spinner} /> : null}
            {props.tone !== 'quiet' ? <StatusDot size={6} color={toneColor} /> : null}
            <Text style={[styles.text, { color: toneColor }]} numberOfLines={props.numberOfLines ?? 1}>{props.text}</Text>
        </View>
    );
    if (!props.action) return line;
    return (
        <View testID={props.testID} style={styles.withAction}>
            {line}
            <TextLinkButton tone="strong" label={props.action.label} onPress={props.action.onPress} testID={props.action.testID} />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        flexShrink: 1,
    },
    withAction: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minWidth: 0,
    },
    spinner: {
        width: 12,
        height: 12,
    },
    text: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        flexShrink: 1,
        fontVariant: ['tabular-nums'],
    },
}));
