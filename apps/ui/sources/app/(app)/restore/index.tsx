import * as React from 'react';
import { Platform } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { useDeviceType } from '@/utils/platform/responsive';
import { RestoreQrView } from '@/components/account/restore/RestoreQrView';
import { RestoreScanComputerQrView } from '@/components/account/restore/RestoreScanComputerQrView';
import { isWebQrScannerSupported } from '@/components/qr/QrCodeScannerView';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

export default function RestoreIndex() {
    const deviceType = useDeviceType();
    const isNativePhone = (Platform.OS === 'ios' || Platform.OS === 'android') && !isRunningOnMac();
    const isWebPhoneWithCamera = Platform.OS === 'web' && deviceType === 'phone' && isWebQrScannerSupported();
    const pairingDecision = useFeatureDecision('auth.pairing.desktopQrMobileScan');
    const pairingState = pairingDecision?.state ?? 'unknown';
    const showScannerFirst =
        (isNativePhone || isWebPhoneWithCamera) && pairingState !== 'disabled' && pairingState !== 'unsupported';

    return showScannerFirst ? <RestoreScanComputerQrView /> : <RestoreQrView />;
}
