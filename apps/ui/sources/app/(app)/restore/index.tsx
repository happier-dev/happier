import * as React from 'react';

import { useRouter } from 'expo-router';

import { RestoreIndexEmbedded } from '@/components/onboardingWizard/restore/RestoreIndexEmbedded';
import { WizardModalShell } from '@/components/onboardingWizard/WizardModalShell';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

export default function RestoreIndex() {
    const router = useRouter();
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);

    return (
        <WizardModalShell
            testID="restore-wizard"
            stepIndex={1}
            stepCount={3}
            title={t('setupOnboarding.authRestoreTitle')}
            subtitle={t('setupOnboarding.authRestoreSubtitle')}
            onBack={handleBack}
            showSkip={false}
        >
            <RestoreIndexEmbedded onBack={handleBack} />
        </WizardModalShell>
    );
}
