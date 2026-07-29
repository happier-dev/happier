import * as React from 'react';
import { useNavigation, useRouter } from 'expo-router';

import { WizardModalShell } from '@/components/onboarding/ui/WizardModalShell';
import { ScanAuthQrScreen } from '@/components/qr/ScanAuthQrScreen';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

export default function ScanAccountQrScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: '/' });
    }, [navigation, router]);

    return (
        <WizardModalShell
            testID="scan-account-wizard"
            stepIndex={1}
            stepCount={1}
            onBack={handleBack}
            showSkip={false}
        >
            <ScanAuthQrScreen
                allowedUrlKind="account"
                fallbackHref="/"
                testIDPrefix="scan-account"
                title={t('connect.linkNewDeviceTitle')}
                subtitle={t('connect.linkNewDeviceSubtitle')}
                permissionRequiredMessage={t('modals.cameraPermissionsRequiredToScanQr')}
                manualEntryPromptTitle={t('connect.enterUrlManually')}
                manualEntryPlaceholder={t('connect.accountUrlPlaceholder')}
                manualEntryConfirmText={t('common.continue')}
            />
        </WizardModalShell>
    );
}
