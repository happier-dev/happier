import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierRowStatusLine, happierPageTextMetrics, type HappierRowStatusLineContentProps, type HappierRowStatusTone } from '@happier-dev/plugin-ui/presentation';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type RowStatusTone = HappierRowStatusTone;

/**
 * The one status line under a row's title (an agent, an installable provider). Healthy states are quiet
 * text; only trouble carries a dot and a tone (needs you, failed); work in progress leads with a small
 * spinner. A line may end with its one next step (Install, Try again) as an inline link.
 */
export const RowStatusLine = React.memo(function RowStatusLine(props: HappierRowStatusLineContentProps) {
    const { theme } = useUnistyles();
    return (
        <HappierRowStatusLine {...props} host={{
            colors: { quiet: theme.colors.text.secondary, warn: theme.colors.state.warning.foreground, bad: theme.colors.state.danger.foreground },
            actionGap: theme.space.s8,
            renderBusy: ({ size }) => <ActivitySpinner size={size} color={theme.colors.text.tertiary} style={styles.spinner} />,
            renderIndicator: ({ size, color }) => <StatusDot size={size} color={color} />,
            renderText: ({ text, numberOfLines, style }) => <Text style={[styles.text, style]} numberOfLines={numberOfLines}>{text}</Text>,
            renderAction: (action) => <TextLinkButton tone="strong" {...action} />,
        }} />
    );
});

const styles = StyleSheet.create(() => ({
    spinner: {
        width: 12,
        height: 12,
    },
    text: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        fontVariant: ['tabular-nums'],
    },
}));
