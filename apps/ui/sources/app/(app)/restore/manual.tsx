import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { t } from '@/text';
import { StyleSheet } from 'react-native-unistyles';
import { WizardModalShell } from '@/components/onboarding/ui/WizardModalShell';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';


const stylesheet = StyleSheet.create((theme) => ({
    body: { paddingHorizontal: 24 },
}));

export default function Restore() {
    const styles = stylesheet;
    const router = useRouter();

    return (
        <WizardModalShell
            testID="restore-manual-wizard"
            stepIndex={1}
            stepCount={3}
            title={t('setupOnboarding.authRestoreTitle')}
            subtitle={t('setupOnboarding.authRestoreSubtitle')}
            onBack={() => safeRouterBack({ router, fallbackHref: '/restore' })}
            showSkip={false}
        >
            <View style={styles.body}>
                <SecretKeyLoginForm />
            </View>
        </WizardModalShell>
    );
}
