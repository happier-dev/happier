import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SessionHandoffRecoveryPlan } from '@/sync/domains/sessionHandoff/recoveryPlan';

type RecoveryAction = 'restart_on_source' | 'keep_stopped';

type Props = CustomModalInjectedProps & Readonly<{
    title: string;
    message: string;
    details?: string;
    recovery: SessionHandoffRecoveryPlan;
    onResolve: (value: RecoveryAction | null) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        width: 440,
        maxWidth: '92%',
        overflow: 'hidden',
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    body: {
        paddingHorizontal: 16,
        paddingVertical: 18,
        gap: 12,
    },
    message: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    details: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    footer: {
        paddingHorizontal: 16,
        paddingBottom: 16,
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 10,
    },
}));

export function SessionHandoffFailureRecoveryModal({ onClose, title, message, details, recovery, onResolve }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const canRestart = recovery.actions.includes('restart_on_source');

    const handleResolve = React.useCallback((value: RecoveryAction | null) => {
        onResolve(value);
        onClose();
    }, [onClose, onResolve]);

    return (
        <View testID="session-handoff-recovery-modal" style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{title}</Text>
                <Pressable
                    testID="session-handoff-recovery-close"
                    onPress={() => handleResolve(null)}
                    hitSlop={10}
                    style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                >
                    <Octicons name="x" size={18} color={theme.colors.header.tint} />
                </Pressable>
            </View>
            <View style={styles.body}>
                <Text style={styles.message}>{message}</Text>
                {details ? <Text style={styles.details}>{details}</Text> : null}
            </View>
            <View style={styles.footer}>
                <RoundButton
                    testID="session-handoff-recovery-keep-stopped"
                    title={t('sessionHandoff.recovery.keepStopped')}
                    onPress={() => handleResolve('keep_stopped')}
                />
                {canRestart ? (
                    <RoundButton
                        testID="session-handoff-recovery-restart-on-source"
                        title={t('sessionHandoff.recovery.restartOnSource')}
                        onPress={() => handleResolve('restart_on_source')}
                    />
                ) : null}
            </View>
        </View>
    );
}
