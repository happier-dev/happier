import * as React from 'react';
import { router, useLocalSearchParams } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { BaseModal } from '@/modal/components/BaseModal';
import { SetupWizardSurface } from '@/components/onboardingWizard/SetupWizardSurface';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import type { WizardContext, WizardStepId } from '@/components/onboardingWizard/wizardTypes';

export default function SetupWizardRoute() {
    const auth = useAuth();
    const params = useLocalSearchParams<{ action?: string; step?: string }>();

    const initialStepId: WizardStepId | undefined = React.useMemo(() => {
        const raw = typeof params.step === 'string' ? params.step.trim() : '';
        const allowed: readonly WizardStepId[] = [
            'setup_chooser',
            'setup_this_computer',
            'host_relay_local',
            'remote_ssh_setup',
            'secure_access_tailscale',
        ];
        return (allowed as readonly string[]).includes(raw) ? (raw as WizardStepId) : undefined;
    }, [params.step]);

    const initialSetupAction: WizardContext['setupAction'] | undefined = React.useMemo(() => {
        const raw = typeof params.action === 'string' ? params.action.trim() : '';
        switch (raw) {
            case 'local':
            case 'relayLocal':
            case 'remote':
            case 'tailscale':
                return raw as WizardContext['setupAction'];
            default:
                return undefined;
        }
    }, [params.action]);

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
            useOuterScrollContainer={true}
            onExit={() => router.replace('/')}
            initialStepId={initialStepId}
            initialSetupAction={initialSetupAction}
        />
    );

    return (
        <BaseModal
            visible={true}
            scrollable={true}
            disableContentTransform={true}
            showBackdrop={false}
            onClose={() => router.replace('/')}
        >
            {content}
        </BaseModal>
    );
}
