import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { RestoreQrView } from '@/components/account/restore/RestoreQrView';
import { RestoreScanComputerQrView } from '@/components/account/restore/RestoreScanComputerQrView';
import { isWebQrScannerSupported } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';

export default function RestoreIndex() {
    const { width, height } = useWindowDimensions();
    const isNativePhone = (Platform.OS === 'ios' || Platform.OS === 'android') && !isRunningOnMac();
    const isWebPhoneWithCamera =
        Platform.OS === 'web' && isWebQrScannerSupported() && isWebMobileLikeQrScannerHost({ width, height });
    const showScannerFirst = isNativePhone || isWebPhoneWithCamera;

    return showScannerFirst ? <RestoreScanComputerQrView /> : <RestoreQrView />;
}
