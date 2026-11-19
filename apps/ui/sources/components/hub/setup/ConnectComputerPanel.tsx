import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useScannedAuthUrlProcessor } from '@/hooks/auth/useScannedAuthUrlProcessor';
import { Modal } from '@/modal';
import { t } from '@/text';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';

/**
 * A phone's "Connect a computer", open in place (lab I4p): the camera inside the row, pointed at the
 * code Happier shows in the computer's terminal, with pasting its link as the other way. Scanned and
 * pasted links go through the one terminal-connect processor; the camera runs only while this is
 * open, and a connected computer closes it.
 */
export const ConnectComputerPanel = React.memo(function ConnectComputerPanel(props: Readonly<{
    testIDPrefix: string;
    close: () => void;
}>) {
    const close = props.close;
    const processorOptions = React.useMemo(() => ({ allowedUrlKind: 'terminal' as const, onApprovalOpened: close }), [close]);
    const { processAuthUrl } = useScannedAuthUrlProcessor(processorOptions);
    const canScan = canUseCurrentDeviceQrScanner();
    const pasteLink = React.useCallback(async () => {
        const url = await Modal.prompt(
            t('modals.authenticateTerminal'),
            t('modals.pasteUrlFromTerminal'),
            { placeholder: t('connect.terminalUrlPlaceholder'), confirmText: t('common.authenticate') },
        );
        if (url?.trim()) await processAuthUrl(url.trim());
    }, [processAuthUrl]);

    return (
        <View testID={`${props.testIDPrefix}-panel`} style={styles.root}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('homeSetup.connectComputerTitle')}</Text>
                {canScan ? null : (
                    <IconButton
                        testID={`${props.testIDPrefix}-close`}
                        iconName="x"
                        variant="plain"
                        size={24}
                        accessibilityLabel={t('homeSetup.close')}
                        onPress={close}
                    />
                )}
            </View>
            {canScan ? (
                <View style={styles.camera}>
                    <QrCodeScannerView
                        embedded
                        active
                        testIDPrefix={`${props.testIDPrefix}-scanner`}
                        title={t('homeSetup.connectComputerTitle')}
                        permissionRequiredMessage={t('modals.cameraPermissionsRequiredToConnectTerminal')}
                        onCancel={close}
                        onScan={async (data) => {
                            if (data.trim()) await processAuthUrl(data.trim());
                        }}
                    />
                </View>
            ) : null}
            <Text style={styles.hint}>
                {canScan ? `${t('homeSetup.connectComputerHint')} ` : ''}
                <Text
                    testID={`${props.testIDPrefix}-paste`}
                    accessibilityRole="button"
                    style={styles.link}
                    onPress={() => { void pasteLink(); }}
                >
                    {t('settingsOverview.setupActionPasteLink')}
                </Text>
            </Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        padding: theme.space.s16,
        gap: theme.space.s12,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    title: {
        ...Typography.variant('heading'),
        flex: 1,
        color: theme.colors.text.primary,
    },
    camera: {
        borderRadius: 16,
        overflow: 'hidden',
    },
    hint: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    link: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
}));
