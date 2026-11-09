import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { describeSessionTerminalStatus, type SessionTerminalStatus } from '../presentation/describeSessionTerminal';

const stylesheet = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    label: { fontSize: 12, lineHeight: 16, color: theme.colors.text.secondary, ...Typography.default() },
    attention: { color: theme.colors.status.actionRequired },
    quiet: { color: theme.colors.text.tertiary },
}));

/**
 * A Jump row's trailing status (terminal lab B4): the same dot colours as the strip's tab slot, said
 * in words. The tab the pane shows reads "Showing"; a quiet terminal says nothing.
 */
export function TerminalJumpStatus(props: Readonly<{ status: SessionTerminalStatus | null; showing: boolean; title?: string }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    if (!props.status) {
        return props.showing ? <Text style={[styles.label, styles.quiet]}>{t('terminalWorkspace.status.showing')}</Text> : null;
    }
    const color = props.status === 'running' ? theme.colors.status.connected
        : props.status === 'attention' ? theme.colors.status.actionRequired
        : props.status === 'failed' ? theme.colors.status.error
        : theme.colors.status.disconnected;
    return (
        <View style={styles.row}>
            <StatusDot color={color} size={6} />
            <Text style={[styles.label, props.status === 'attention' ? styles.attention : null]}>{describeSessionTerminalStatus(props.status, props.title)}</Text>
        </View>
    );
}
