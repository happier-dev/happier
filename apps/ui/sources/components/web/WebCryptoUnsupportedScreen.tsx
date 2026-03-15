import * as React from 'react';
import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { t } from '@/text';
import { AppBlockingScreen, type AppBlockingScreenAction } from '@/components/appShell/AppCrashRecoveryBoundary';
import type { WebCryptoSupportSnapshot } from '@/platform/webCryptoSupport';

function formatWebCryptoGateDetails(snapshot: WebCryptoSupportSnapshot): string {
    const lines: string[] = [
        `- ${t('webCryptoGate.fixHttps')}`,
        `- ${t('webCryptoGate.fixTunnel')}`,
        `- ${t('webCryptoGate.fixLocalhost')}`,
        '',
        `${t('webCryptoGate.currentOrigin')}: ${snapshot.origin ?? '—'}`,
        `${t('webCryptoGate.secureContext')}: ${typeof snapshot.isSecureContext === 'boolean' ? String(snapshot.isSecureContext) : '—'}`,
    ];
    if (snapshot.missing.length > 0) {
        lines.push(`missing: ${snapshot.missing.join(',')}`);
    }
    return lines.join('\n');
}

export function WebCryptoUnsupportedScreen(props: Readonly<{ snapshot: WebCryptoSupportSnapshot }>): React.ReactElement {
    const snapshot = props.snapshot;
    const [copied, setCopied] = React.useState(false);

    const copyDetails = React.useCallback(() => {
        const details = [
            'webCryptoSupport=false',
            snapshot.origin ? `origin=${snapshot.origin}` : null,
            typeof snapshot.isSecureContext === 'boolean' ? `isSecureContext=${snapshot.isSecureContext}` : null,
            snapshot.missing.length > 0 ? `missing=${snapshot.missing.join(',')}` : null,
        ].filter(Boolean).join('\n');

        void Clipboard.setStringAsync(details)
            .then(() => setCopied(true))
            .catch(() => {});
    }, [snapshot.origin, snapshot.isSecureContext, snapshot.missing]);

    const reload = React.useCallback(() => {
        if (Platform.OS === 'web') {
            try {
                (globalThis as any).location?.reload?.();
            } catch {
                // ignore
            }
        }
    }, []);

    const primary: AppBlockingScreenAction = {
        testID: 'webcrypto-copy-details',
        label: copied ? t('common.copied') : t('webCryptoGate.copyDetails'),
        onPress: copyDetails,
        variant: 'primary',
    };
    const secondary: AppBlockingScreenAction = {
        testID: 'webcrypto-reload',
        label: t('webCryptoGate.reload'),
        onPress: reload,
        variant: 'secondary',
    };

    return (
        <AppBlockingScreen
            testID="webcrypto-unsupported"
            title={t('webCryptoGate.title')}
            subtitle={t('webCryptoGate.subtitle')}
            detailsTitle={t('webCryptoGate.howToFix')}
            details={formatWebCryptoGateDetails(snapshot)}
            actions={[primary, secondary]}
        />
    );
}
