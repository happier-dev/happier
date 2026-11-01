import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemInfoNotice } from '@/components/ui/lists/ItemInfoNotice';
import { useAuth } from '@/auth/context/AuthContext';
import { useScannedAuthUrlProcessor } from '@/hooks/auth/useScannedAuthUrlProcessor';
import { useEndpointConnectivity, useSocketStatus } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';

import { QrCodeScannerView } from './QrCodeScannerView';

type ScanAuthQrScreenProps = Readonly<{
    testIDPrefix: string;
}>;

export function ScanAuthQrScreen(props: ScanAuthQrScreenProps) {
    const router = useRouter();
    const auth = useAuth();
    const socket = useSocketStatus();
    const endpoint = useEndpointConnectivity();
    const showConnectionWarning = endpoint.status === 'offline'
        || endpoint.status === 'auth_failed'
        || (auth.isAuthenticated && socket.status !== 'connected');
    const { processAuthUrl } = useScannedAuthUrlProcessor({
        onSuccess: () => router.back(),
    });

    return (
        <QrCodeScannerView
            testIDPrefix={props.testIDPrefix}
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
                    {showConnectionWarning ? (
                        <View
                            testID={`${props.testIDPrefix}-connection-warning`}
                            accessible
                            accessibilityRole="alert"
                            accessibilityLiveRegion="polite"
                        >
                            <ItemInfoNotice
                                title={t('connect.pairingConnectionWarningTitle')}
                                body={t('connect.pairingConnectionWarningBody')}
                            />
                        </View>
                    ) : null}
                    <RoundButton
                        testID={`${props.testIDPrefix}-enter-url`}
                        size="normal"
                        title={t('connect.enterUrlManually')}
                        action={async () => {
                            const url = await Modal.prompt(
                                t('connect.linkNewDeviceTitle'),
                                undefined,
                                {
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
