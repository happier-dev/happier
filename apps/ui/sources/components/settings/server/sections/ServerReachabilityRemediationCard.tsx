import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type {
    EndpointReachabilityRemediation,
    EndpointReachabilityRemediationAction,
} from '@/components/serverReachability/remediation';
import { SystemTaskProgressCard } from '@/components/systemTasks';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type ServerReachabilityRemediationCardProps = Readonly<{
    remediation: EndpointReachabilityRemediation;
    disabled?: boolean;
    taskSnapshot?: SystemTaskRunState | null;
    onAction: (actionId: EndpointReachabilityRemediationAction['id']) => Promise<void> | void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginBottom: 12,
        padding: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 10,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    iconWrap: {
        width: 28,
        height: 28,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
    textColumn: {
        flex: 1,
        gap: 4,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    body: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.text.secondary,
        lineHeight: 19,
    },
    actionsRow: {
        flexDirection: 'row',
        gap: 8,
    },
    actionWrap: {
        flex: 1,
    },
}));

export function ServerReachabilityRemediationCard(props: ServerReachabilityRemediationCardProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isTaskRunning = props.taskSnapshot != null && props.taskSnapshot.result == null;

    return (
        <View testID="server-settings-add-reachability-remediation" style={styles.container}>
            <View style={styles.headerRow}>
                <View style={styles.iconWrap}>
                    <Icon name="shield-check" size={16} color={theme.colors.text.link} />
                </View>
                <View style={styles.textColumn}>
                    <Text style={styles.title}>{t(props.remediation.titleKey)}</Text>
                    <Text style={styles.body}>{t(props.remediation.bodyKey)}</Text>
                </View>
            </View>

            <View style={styles.actionsRow}>
                {props.remediation.actions.map((action) => (
                    <View key={action.id} style={styles.actionWrap}>
                        <RoundButton
                            testID={`server-settings-add-remediation-action-${action.id}`}
                            title={t(action.labelKey)}
                            size="normal"
                            display={action.kind === 'retry' ? 'default' : 'inverted'}
                            loading={action.kind === 'callback' && isTaskRunning}
                            disabled={props.disabled || (isTaskRunning && action.kind !== 'callback')}
                            action={async () => {
                                await props.onAction(action.id);
                            }}
                        />
                    </View>
                ))}
            </View>
            {props.taskSnapshot ? (
                <SystemTaskProgressCard
                    title={null}
                    snapshot={props.taskSnapshot}
                    variant="checklistOnly"
                    showStepMessages={false}
                    showOpenLogs={false}
                />
            ) : null}
        </View>
    );
}
