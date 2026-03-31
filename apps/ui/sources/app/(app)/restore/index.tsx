import * as React from 'react';
import { Platform } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { RestoreQrView } from '@/components/account/restore/RestoreQrView';
import { RestoreScanComputerQrView } from '@/components/account/restore/RestoreScanComputerQrView';
import { isWebQrScannerSupported } from '@/utils/platform/qrScannerSupport';

export default function RestoreIndex() {
    const isNativePhone = (Platform.OS === 'ios' || Platform.OS === 'android') && !isRunningOnMac();
    const webHasCamera = Platform.OS === 'web' && isWebQrScannerSupported();
    const showScannerFirst = isNativePhone || webHasCamera;

    return showScannerFirst ? <RestoreScanComputerQrView /> : <RestoreQrView />;
}
