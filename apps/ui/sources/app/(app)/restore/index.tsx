import * as React from 'react';

import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { RestoreIndexEmbedded } from '@/components/onboarding/restore/RestoreIndexEmbedded';
import { WizardModalShell } from '@/components/onboarding';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

export default function RestoreIndex() {
    const router = useRouter();
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);

    return (
        <View
            testID="unauth-shell-route-restore"
            style={{ flex: 1 }}
        >
            <WizardModalShell
                testID="restore-wizard"
                stepIndex={1}
                stepCount={3}
                title={t('setupOnboarding.authRestoreTitle')}
                subtitle={t('setupOnboarding.authRestoreSubtitle')}
                onBack={handleBack}
                showSkip={false}
            >
                <View testID="restore-route-content">
                    <RestoreIndexEmbedded onBack={handleBack} />
                </View>
            </WizardModalShell>
        </View>
    );
}
