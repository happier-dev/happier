import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { formatMachineAgentStatus } from './machineAgentCopy';
import type { MachineAgentStatus } from './machineAgentPresentation';

/**
 * The one status line of an agent row or card. Healthy states are quiet text; only trouble carries a
 * dot and a tone (needs sign-in, failed); work in progress (installing, checking, waiting for sign-in)
 * leads with a small spinner.
 */
export const MachineAgentStatusLine = React.memo(function MachineAgentStatusLine(props: Readonly<{
    status: MachineAgentStatus;
    testID?: string;
    /** Cards allow two lines; rows keep one. */
    numberOfLines?: number;
}>) {
    const { theme } = useUnistyles();
    const { status } = props;
    const text = formatMachineAgentStatus(status);
    const busy = status.kind === 'installing' || status.kind === 'checking' || status.kind === 'waitingForSignIn';
    const toneColor = status.tone === 'warn'
        ? theme.colors.state.warning.foreground
        : status.tone === 'bad'
            ? theme.colors.state.danger.foreground
            : theme.colors.text.secondary;
    return (
        <View testID={props.testID} style={styles.line} accessible accessibilityLabel={text}>
            {busy ? <ActivitySpinner size={12} color={theme.colors.text.tertiary} style={styles.spinner} /> : null}
            {status.tone !== 'quiet' ? <StatusDot size={6} color={toneColor} /> : null}
            <Text style={[styles.text, { color: toneColor }]} numberOfLines={props.numberOfLines ?? 1}>{text}</Text>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
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
