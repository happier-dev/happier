import * as React from 'react';

import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RestoreQrView } from '@/components/account/restore/RestoreQrView';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

const ignoreBrandHeroGetStarted = () => undefined;

export default function RestoreShowQrRoute() {
    const router = useRouter();
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/restore' });
    }, [router]);
    const handleOpenRelayCustomFlow = React.useCallback(() => {
        router.push('/setup');
    }, [router]);

    return (
        <UnauthenticatedSplitShell
            stepId="restore-show-qr"
            isWelcomeStep={false}
            allowMobileBrandHero={false}
            onOpenRelayCustomFlow={handleOpenRelayCustomFlow}
            onBrandHeroGetStarted={ignoreBrandHeroGetStarted}
            onBack={handleBack}
            testID="unauth-shell-route-restore-show-qr"
        >
            <View testID="restore-route-content" style={styles.content}>
                <RestoreQrView embedded onBack={handleBack} />
            </View>
        </UnauthenticatedSplitShell>
    );
}

const styles = StyleSheet.create(() => ({
    content: {
        flex: 1,
        width: '100%',
    },
}));
