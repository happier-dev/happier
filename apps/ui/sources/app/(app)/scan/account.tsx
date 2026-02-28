import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useConnectAccount } from '@/hooks/auth/useConnectAccount';

export default function ScanAccountQrScreen() {
    const router = useRouter();
    const { processAuthUrl } = useConnectAccount({
        onSuccess: () => router.back(),
    });

    return (
        <QrCodeScannerView
            testIDPrefix="scan-account"
            title={t('connect.linkNewDeviceTitle')}
            subtitle={t('connect.linkNewDeviceSubtitle')}
            permissionRequiredMessage={t('modals.cameraPermissionsRequiredToScanQr')}
            onCancel={() => router.back()}
            onScan={async (data) => {
                if (data.trim()) {
                    await processAuthUrl(data.trim());
                }
            }}
            footer={
                <View style={{ width: '100%', maxWidth: 360 }}>
                    <RoundButton
                        testID="scan-account-enter-url"
                        size="normal"
                        title={t('connect.enterUrlManually')}
                        action={async () => {
                            const url = await Modal.prompt(
                                t('connect.enterUrlManually'),
                                undefined,
                                {
                                    placeholder: t('connect.accountUrlPlaceholder'),
                                    confirmText: t('common.continue'),
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
