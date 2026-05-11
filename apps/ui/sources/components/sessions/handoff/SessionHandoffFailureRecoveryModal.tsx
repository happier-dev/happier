import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
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
    onRequestClose?: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 16,
        paddingVertical: 18,
        gap: 12,
    },
    message: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    details: {
        fontSize: 13,
        color: theme.colors.text.primary,
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

export function SessionHandoffFailureRecoveryModal({ onClose, setChrome, title, message, details, recovery, onResolve }: Props) {
    const styles = stylesheet;
    const canRestart = recovery.actions.includes('restart_on_source');

    const handleResolve = React.useCallback((value: RecoveryAction | null) => {
        onResolve(value);
        onClose();
    }, [onClose, onResolve]);

    const footer = React.useMemo(() => (
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
    ), [canRestart, handleResolve, styles.footer]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title,
        testID: 'session-handoff-recovery-modal',
        titleTestID: 'session-handoff-recovery-title',
        closeButtonTestID: 'session-handoff-recovery-close',
        bodyScroll: 'auto' as const,
        dimensions: { width: 440, maxHeightRatio: 0.92 },
        footer,
    }), [footer, title]);

    useModalCardChrome(setChrome, chrome);

    return (
        <View style={styles.body}>
            <Text testID="session-handoff-recovery-message" style={styles.message}>{message}</Text>
            {details ? <Text testID="session-handoff-recovery-details" style={styles.details}>{details}</Text> : null}
        </View>
    );
}
