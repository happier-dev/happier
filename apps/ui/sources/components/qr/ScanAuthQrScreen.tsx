import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import type { Href } from 'expo-router';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { useAuth } from '@/auth/context/AuthContext';
import { getStorage } from '@/sync/domains/state/storageStore';
import { socketPresentsHomeOnline } from '@/sync/api/session/socketStatusPresentation';
import { PairingLinkEntryForm } from '@/components/account/restore/PairingLinkEntryForm';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

import { useScannedAuthUrlProcessor } from '@/hooks/auth/useScannedAuthUrlProcessor';
import type { HomeQrEntryIntent } from '@/auth/pairing/homeQrEntryIntent';
import { QrCodeScannerView } from './QrCodeScannerView';

type ScanAuthQrScreenBaseProps = Readonly<{
    fallbackHref: Href;
    title: string;
    subtitle: string;
    permissionRequiredMessage: string;
    manualEntryTitle: string;
    manualEntryDescription?: string;
    manualEntryPlaceholder?: string;
    manualEntrySubmitText: string;
    testIDPrefix: string;
}>;

type ScanAuthQrScreenProps = ScanAuthQrScreenBaseProps & (
    | Readonly<{
        allowedUrlKind: 'account';
        homeQrEntryIntent: HomeQrEntryIntent;
    }>
    | Readonly<{
        allowedUrlKind: 'terminal';
        homeQrEntryIntent?: never;
    }>
);

function PairingConnectionWarning(props: Readonly<{ testID: string }>) {
    const { isAuthenticated } = useAuth();
    const showWarning = getStorage()((state) => state.endpointStatus === 'offline'
        || state.endpointStatus === 'auth_failed'
        || (isAuthenticated && !socketPresentsHomeOnline(state.socketStatus)));
    if (!showWarning) return null;

    return (
        <AttentionBanner
            testID={props.testID}
            title={t('connect.pairingConnectionWarningTitle')}
            description={t('connect.pairingConnectionWarningBody')}
            tone="warning"
            placement="inline"
            presentation="strip"
            announce="alert"
            accessibilityLiveRegion="polite"
        />
    );
}

export function ScanAuthQrScreen(props: ScanAuthQrScreenProps) {
    const router = useRouter();
    const navigation = useNavigation();
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: props.fallbackHref });
    }, [navigation, props.fallbackHref, router] satisfies readonly [typeof navigation, Href, typeof router]);
    const showQrInstead = React.useCallback(() => {
        router.replace('/settings/add-phone');
    }, [router]);
    const processorOptions = props.allowedUrlKind === 'account'
        ? {
            allowedUrlKind: props.allowedUrlKind,
            homeQrEntryIntent: props.homeQrEntryIntent,
            onSuccess: handleBack,
            // A legacy account link cannot be approved here; this device's own
            // QR is the recovery the signed-in scanner can actually offer.
            onShowQrInstead: showQrInstead,
        } as const
        : {
            allowedUrlKind: props.allowedUrlKind,
            onSuccess: handleBack,
        } as const;
    const { processAuthUrl } = useScannedAuthUrlProcessor(processorOptions);
    const [view, setView] = React.useState<'scanner' | 'paste'>('scanner');
    const [scannerPaused, setScannerPaused] = React.useState(false);
    const showScanner = React.useCallback(() => {
        setScannerPaused(false);
        setView('scanner');
    }, []);

    // Camera and paste share one processor: the restore flow's link form is the
    // canonical manual-entry surface, so this screen switches views instead of
    // owning a second entry presentation.
    if (view === 'paste') {
        return (
            <View style={{ flex: 1 }}>
                <PairingConnectionWarning testID={`${props.testIDPrefix}-connection-warning`} />
                <PairingLinkEntryForm
                    onBack={showScanner}
                    onSubmit={processAuthUrl}
                    title={props.manualEntryTitle}
                    description={props.manualEntryDescription}
                    placeholder={props.manualEntryPlaceholder}
                    submitLabel={props.manualEntrySubmitText}
                    backLabel={t('connect.scanNewQr')}
                />
            </View>
        );
    }

    const manualEntryButton = (
        <RoundButton
            testID={`${props.testIDPrefix}-enter-url`}
            size="normal"
            display={scannerPaused ? 'secondary' : 'default'}
            title={t('connect.enterUrlManually')}
            onPress={() => setView('paste')}
        />
    );

    return (
        <View style={{ flex: 1 }}>
            <PairingConnectionWarning testID={`${props.testIDPrefix}-connection-warning`} />
            <QrCodeScannerView
                active={!scannerPaused}
                embedded
                testIDPrefix={props.testIDPrefix}
                title={props.title}
                subtitle={props.subtitle}
                permissionRequiredMessage={props.permissionRequiredMessage}
                onCancel={handleBack}
                onScan={async (data) => {
                    if (data.trim()) {
                        try {
                            await processAuthUrl(data.trim());
                        } finally {
                            // Leaving the QR in view must not reopen a declined approval
                            // or error as soon as the camera's in-flight guard releases.
                            setScannerPaused(true);
                        }
                    }
                }}
                footer={
                    <View style={{ width: '100%', maxWidth: 360 }}>
                        {manualEntryButton}
                    </View>
                }
            />
            {scannerPaused ? (
                <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ width: '100%', maxWidth: 360, gap: 10 }}>
                        <RoundButton
                            testID={`${props.testIDPrefix}-scan-again`}
                            size="normal"
                            title={t('connect.scanNewQr')}
                            onPress={showScanner}
                        />
                        {manualEntryButton}
                        <RoundButton
                            testID={`${props.testIDPrefix}-cancel`}
                            size="normal"
                            display="inverted"
                            title={t('common.back')}
                            onPress={handleBack}
                        />
                    </View>
                </View>
            ) : null}
        </View>
    );
}
