import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';

export default function ScanTerminalQrScreen() {
    const router = useRouter();
    const { processAuthUrl } = useConnectTerminal({
        onSuccess: () => router.back(),
    });

    return (
        <QrCodeScannerView
            testIDPrefix="scan-terminal"
            title={t('modals.authenticateTerminal')}
            subtitle={t('connect.scanQrCodeOnDevice')}
            permissionRequiredMessage={t('modals.cameraPermissionsRequiredToConnectTerminal')}
            onCancel={() => router.back()}
            onScan={async (data) => {
                if (data.trim()) {
                    await processAuthUrl(data.trim());
                }
            }}
            footer={
                <View style={{ width: '100%', maxWidth: 360 }}>
                    <RoundButton
                        testID="scan-terminal-enter-url"
                        size="normal"
                        title={t('connect.enterUrlManually')}
                        action={async () => {
                            const url = await Modal.prompt(
                                t('modals.authenticateTerminal'),
                                t('modals.pasteUrlFromTerminal'),
                                {
                                    placeholder: t('connect.terminalUrlPlaceholder'),
                                    confirmText: t('common.authenticate'),
                                    cancelText: t('common.cancel'),
                                },
                            );
                            if (typeof url === 'string' && url.trim()) {
                                await processAuthUrl(url.trim());
                            }
                        }}
                    />
                </View>
            }
        />
    );
}
