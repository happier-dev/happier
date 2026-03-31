import * as React from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { SetupWizardSurface } from '@/components/onboardingWizard/SetupWizardSurface';
import { BaseModal } from '@/modal/components/BaseModal';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';

export default function SetupWizardRoute() {
    const auth = useAuth();

    React.useEffect(() => {
        if (!auth.isAuthenticated) {
            clearPendingSetupIntent();
            router.replace('/');
        }
    }, [auth.isAuthenticated]);

    if (!auth.isAuthenticated) {
        return null;
    }

    const content = (
        <SetupWizardSurface
            testID="setupWizard.surface"
            isDesktopShell={isTauriDesktop()}
            onExit={() => router.replace('/')}
        />
    );

    if (Platform.OS === 'web') {
        return (
            <BaseModal
                visible={true}
                onClose={() => router.replace('/')}
                showBackdrop={false}
                closeOnBackdrop={true}
            >
                {content}
            </BaseModal>
        );
    }

    return content;
}
