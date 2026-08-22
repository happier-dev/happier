import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { isDesktopHost } from '@/utils/platform/desktopHost';
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
    const isDesktopShell = React.useMemo(() => isDesktopHost(), []);
    const canUseScanner = canUseCurrentDeviceQrScanner();
    const isNativePhone = (Platform.OS === 'ios' || Platform.OS === 'android') && !isRunningOnMac();
    const heuristicViewport = React.useMemo(() => {
        if (Platform.OS !== 'web') {
            return { width, height };
        }
        if (!isDesktopShell) {
            return { width, height };
        }
        const screen =
            (globalThis as unknown as { screen?: unknown }).screen
            ?? (typeof window !== 'undefined' ? window.screen : null);
        const screenWidth = typeof (screen as { availWidth?: unknown } | null)?.availWidth === 'number'
            ? Number((screen as { availWidth: number }).availWidth)
            : (typeof (screen as { width?: unknown } | null)?.width === 'number' ? Number((screen as { width: number }).width) : 0);
        const screenHeight = typeof (screen as { availHeight?: unknown } | null)?.availHeight === 'number'
            ? Number((screen as { availHeight: number }).availHeight)
            : (typeof (screen as { height?: unknown } | null)?.height === 'number' ? Number((screen as { height: number }).height) : 0);
        if (Number.isFinite(screenWidth) && Number.isFinite(screenHeight) && screenWidth > 0 && screenHeight > 0) {
            return { width: screenWidth, height: screenHeight };
        }
        return { width, height };
    }, [height, isDesktopShell, width]);
    const isWebPhoneWithCamera =
        Platform.OS === 'web' && canUseScanner && isWebMobileLikeQrScannerHost(heuristicViewport);
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
