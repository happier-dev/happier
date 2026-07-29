import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';
import type { TransferFinalizeRecoveryAction } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';

type Props = CustomModalInjectedProps & Readonly<{
    title: string;
    message: string;
    onResolve: (action: TransferFinalizeRecoveryAction | null) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 16,
        paddingVertical: 18,
    },
    message: {
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 10,
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
}));

export function TransferFinalizeRecoveryModal({
    message,
    onClose,
    onResolve,
    setChrome,
    title,
}: Props): React.ReactElement {
    const styles = stylesheet;
    const resolve = React.useCallback((action: TransferFinalizeRecoveryAction | null) => {
        onResolve(action);
        onClose();
    }, [onClose, onResolve]);
    const footer = React.useMemo(() => (
        <View style={styles.footer}>
            <RoundButton
                testID="transfer-finalize-recovery-discard"
                title={t('transferRecovery.discardStagedUpload')}
                accessibilityLabel={t('transferRecovery.discardStagedUpload')}
                display="inverted"
                onPress={() => resolve('discard_staged')}
            />
            <RoundButton
                testID="transfer-finalize-recovery-retry"
                title={t('transferRecovery.retryFinalization')}
                accessibilityLabel={t('transferRecovery.retryFinalization')}
                onPress={() => resolve('retry_finalize')}
            />
        </View>
    ), [resolve, styles.footer]);

    useModalCardChrome(setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title,
        testID: 'transfer-finalize-recovery-modal',
        titleTestID: 'transfer-finalize-recovery-title',
        closeButtonTestID: 'transfer-finalize-recovery-close',
        bodyScroll: 'auto' as const,
        dimensions: { width: 440, maxHeightRatio: 0.9 },
        footer,
    }), [footer, title]));

    return (
        <View style={styles.body}>
            <Text testID="transfer-finalize-recovery-message" style={styles.message}>
                {message}
            </Text>
        </View>
    );
}
