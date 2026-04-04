import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';

import { RestoreQrView } from '@/components/account/restore/RestoreQrView';
import { RestoreScanComputerQrView } from '@/components/account/restore/RestoreScanComputerQrView';

export type RestoreIndexEmbeddedProps = Readonly<{
    onBack: () => void;
    onOpenSecretKeyLogin?: () => void;
}>;

export const RestoreIndexEmbedded = React.memo(function RestoreIndexEmbedded(props: RestoreIndexEmbeddedProps) {
    const { width, height } = useWindowDimensions();
    const canUseScanner = canUseCurrentDeviceQrScanner();
    const isNativePhone = (Platform.OS === 'ios' || Platform.OS === 'android') && !isRunningOnMac();
    const isWebPhoneWithCamera =
        Platform.OS === 'web' && canUseScanner && isWebMobileLikeQrScannerHost({ width, height });
    const showScannerFirst = isNativePhone || isWebPhoneWithCamera;
    const [currentView, setCurrentView] = React.useState<'qr' | 'scanner' | null>(null);
    const activeView = currentView ?? (showScannerFirst ? 'scanner' : 'qr');

    return activeView === 'scanner' ? (
        <RestoreScanComputerQrView
            embedded
            onBack={props.onBack}
            onOpenSecretKeyLogin={props.onOpenSecretKeyLogin}
            onShowQrInstead={() => setCurrentView('qr')}
        />
    ) : (
        <RestoreQrView
            embedded
            onBack={props.onBack}
            onOpenSecretKeyLogin={props.onOpenSecretKeyLogin}
            onOpenScanQr={canUseScanner ? () => setCurrentView('scanner') : undefined}
        />
    );
});
