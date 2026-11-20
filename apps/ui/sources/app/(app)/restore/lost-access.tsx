import * as React from 'react';
import { useRouter } from 'expo-router';

import { LostAccessEmbedded } from '@/components/onboarding/restore/LostAccessEmbedded';
import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

export default function LostAccessScreen() {
    const router = useRouter();
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);
    return (
        <AuthRouteStepFrame
            routeBack
            testID="restore-lost-access-wizard"
            progress={{ index: 1, count: 3 }}
            title={t('setupOnboarding.authLostAccessTitle')}
            subtitle={t('setupOnboarding.authLostAccessSubtitle')}
            onBack={handleBack}
            bodyOwnsHeading
        >
            <LostAccessEmbedded />
        </AuthRouteStepFrame>
    );
}
