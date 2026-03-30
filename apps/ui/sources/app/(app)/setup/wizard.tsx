import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { SetupAccessGateNotice } from './SetupAccessGateNotice';
import { SetupWizardSurface } from '@/components/onboardingWizard/SetupWizardSurface';
import { isTauriDesktop } from '@/utils/platform/tauri';

export default function SetupWizardRoute() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <SetupAccessGateNotice />;
    }

    return (
        <SetupWizardSurface
            testID="setupWizard.surface"
            isDesktopShell={isTauriDesktop()}
        />
    );
}
