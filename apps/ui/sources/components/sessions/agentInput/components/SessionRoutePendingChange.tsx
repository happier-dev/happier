import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type SessionRoutePendingChangeProps = Readonly<{
    /** What the running session still uses, and what it switches to: "<source> · <model>". */
    now: string;
    next: string;
    /** The source named in the consequence line ("keeps running through …"). */
    nowSource: string;
    agentName: string;
    /** The session's existing restart for a changed route; absent when nothing can restart it here. */
    onRestart?: () => void | Promise<void>;
    restartDisabled?: boolean;
    onKeepCurrent: () => void;
}>;

/**
 * The "Runs through" popover's lead while a requested route waits for the Agent to restart (RT3):
 * what applies now, what comes next, and the session's own restart. It decides nothing; keeping the
 * current route just leaves the change pending.
 */
export function SessionRoutePendingChange(props: SessionRoutePendingChangeProps) {
    return (
        <WarningActionBanner
            testID="session-route-pending-change"
            iconName={null}
            content={(
                <View style={styles.rows}>
                    <View style={styles.row}>
                        <Text style={styles.term}>{t('connectedServices.authChip.now')}</Text>
                        <Text testID="session-route-pending-change.now" numberOfLines={1} style={styles.value}>{props.now}</Text>
                    </View>
                    <View style={styles.row}>
                        <Text style={styles.term}>{t('connectedServices.authChip.next')}</Text>
                        <Text testID="session-route-pending-change.next" numberOfLines={1} style={styles.value}>{props.next}</Text>
                    </View>
                </View>
            )}
            body={t('connectedServices.authChip.switchesOnRestart', { agent: props.agentName, source: props.nowSource })}
            {...(props.onRestart ? {
                actionLabel: t('connectedServices.authChip.restartAgent', { agent: props.agentName }),
                actionAccessibilityLabel: t('connectedServices.authChip.restartAgent', { agent: props.agentName }),
                actionTestID: 'session-route-pending-change.restart',
                onActionPress: props.onRestart,
                disabled: props.restartDisabled,
            } : {})}
            secondaryActions={[{
                key: 'keep-current',
                label: t('connectedServices.authChip.keepCurrent'),
                accessibilityLabel: t('connectedServices.authChip.keepCurrent'),
                testID: 'session-route-pending-change.keep-current',
                variant: 'quiet',
                onPress: props.onKeepCurrent,
            }]}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    rows: { gap: 2 },
    row: { flexDirection: 'row', alignItems: 'baseline', gap: theme.margins.sm },
    term: { ...Typography.rowMeta(), minWidth: 36, color: theme.colors.text.tertiary },
    value: { ...Typography.rowMeta(), ...Typography.default('semiBold'), flexShrink: 1, color: theme.colors.text.primary },
}));
