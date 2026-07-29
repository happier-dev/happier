import * as React from 'react';
import { useRouter } from 'expo-router';

import { LostAccessEmbedded } from '@/components/onboarding/restore/LostAccessEmbedded';
import { WizardModalShell } from '@/components/onboarding/ui/WizardModalShell';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

export default function LostAccessScreen() {
    const router = useRouter();
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);
    return (
        <WizardModalShell
            testID="restore-lost-access-wizard"
            stepIndex={1}
            stepCount={3}
            title={t('setupOnboarding.authLostAccessTitle')}
            subtitle={t('setupOnboarding.authLostAccessSubtitle')}
            onBack={handleBack}
            showSkip={false}
        >
            <LostAccessEmbedded onBack={handleBack} />
        </WizardModalShell>
    );
}
