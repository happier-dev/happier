import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';

import { readWebCryptoSupportSnapshot } from '@/platform/webCryptoSupport';
import { WebCryptoUnsupportedScreen } from '@/components/web/WebCryptoUnsupportedScreen';

export function WebCryptoStartupGate(props: { children: React.ReactNode }) {
    const snapshot = React.useMemo(() => readWebCryptoSupportSnapshot(), []);
    React.useEffect(() => {
        if (snapshot.supported) return;
        // If we block boot due to missing WebCrypto, ensure the user actually sees the gate UI.
        void SplashScreen.hideAsync().catch(() => {});
    }, [snapshot.supported]);
    if (!snapshot.supported) {
        return <WebCryptoUnsupportedScreen snapshot={snapshot} />;
    }
    return <>{props.children}</>;
}
