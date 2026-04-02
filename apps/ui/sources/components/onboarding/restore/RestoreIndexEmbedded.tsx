import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebQrScannerSupported } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';

import { RestoreQrView } from '@/components/account/restore/RestoreQrView';
import { RestoreScanComputerQrView } from '@/components/account/restore/RestoreScanComputerQrView';

export type RestoreIndexEmbeddedProps = Readonly<{
    onBack: () => void;
    onOpenSecretKeyLogin?: () => void;
}>;

export const RestoreIndexEmbedded = React.memo(function RestoreIndexEmbedded(props: RestoreIndexEmbeddedProps) {
    const { width, height } = useWindowDimensions();
    const isNativePhone = (Platform.OS === 'ios' || Platform.OS === 'android') && !isRunningOnMac();
    const isWebPhoneWithCamera =
        Platform.OS === 'web' && isWebQrScannerSupported() && isWebMobileLikeQrScannerHost({ width, height });
    const showScannerFirst = isNativePhone || isWebPhoneWithCamera;
    const [forceQrView, setForceQrView] = React.useState(false);

    return showScannerFirst && !forceQrView ? (
        <RestoreScanComputerQrView
            embedded
            onBack={props.onBack}
            onOpenSecretKeyLogin={props.onOpenSecretKeyLogin}
            onShowQrInstead={() => setForceQrView(true)}
        />
    ) : (
        <RestoreQrView embedded onBack={props.onBack} onOpenSecretKeyLogin={props.onOpenSecretKeyLogin} />
    );
});
