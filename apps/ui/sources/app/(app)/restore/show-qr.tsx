import * as React from 'react';

import { useRouter } from 'expo-router';

import { RestoreQrView } from '@/components/account/restore/RestoreQrView';
import { WizardModalShell } from '@/components/onboarding';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

export default function RestoreShowQrRoute() {
    const router = useRouter();
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/restore' });
    }, [router]);

    return (
        <WizardModalShell
            testID="restore-show-qr-wizard"
            stepIndex={1}
            stepCount={3}
            title={t('setupOnboarding.authRestoreTitle')}
            subtitle={t('setupOnboarding.authRestoreSubtitle')}
            onBack={handleBack}
            showSkip={false}
        >
            <RestoreQrView embedded onBack={handleBack} />
        </WizardModalShell>
    );
}
