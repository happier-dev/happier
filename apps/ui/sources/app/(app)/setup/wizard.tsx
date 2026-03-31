import * as React from 'react';
import { router } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { SetupWizardSurface } from '@/components/onboardingWizard/SetupWizardSurface';
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

    return (
        <SetupWizardSurface
            testID="setupWizard.surface"
            isDesktopShell={isTauriDesktop()}
        />
    );
}
