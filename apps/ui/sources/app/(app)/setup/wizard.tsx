import * as React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useWindowDimensions } from 'react-native';

import { useAuth } from '@/auth/context/AuthContext';
import { BaseModal } from '@/modal/components/BaseModal';
import { SetupWizardSurface } from '@/components/onboarding/surfaces/SetupWizardSurface';
import { shouldUseWizardFullscreenPresentation } from '@/components/onboarding/ui/wizardPresentation';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import type { WizardContext, WizardStepId } from '@/components/onboarding/state/wizardTypes';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { t } from '@/text';

export default function SetupWizardRoute() {
    const auth = useAuth();
    const { width: windowWidth } = useWindowDimensions();
    const params = useLocalSearchParams<{ action?: string; step?: string; scope?: string }>();
    const [hydrationAttempted, setHydrationAttempted] = React.useState(false);
    const applyLocalSettings = useApplyLocalSettings();
    const shouldTopAlignWebModal = shouldUseWizardFullscreenPresentation(windowWidth);

    const initialStepId: WizardStepId | undefined = React.useMemo(() => {
        const raw = typeof params.step === 'string' ? params.step.trim() : '';
        const allowed: readonly WizardStepId[] = [
            'setup_chooser',
            'setup_this_computer',
            'host_relay_local',
            'remote_ssh_setup',
        ];
        return (allowed as readonly string[]).includes(raw) ? (raw as WizardStepId) : undefined;
    }, [params.step]);

    const initialSetupAction: WizardContext['setupAction'] | undefined = React.useMemo(() => {
        const raw = typeof params.action === 'string' ? params.action.trim() : '';
        switch (raw) {
            case 'local':
            case 'relayLocal':
            case 'remote':
                return raw as WizardContext['setupAction'];
            default:
                return undefined;
        }
    }, [params.action]);

    const scope = React.useMemo(() => {
        const raw = typeof params.scope === 'string' ? params.scope.trim() : '';
        if (raw === 'relay' || raw === 'machine' || raw === 'all') {
            return raw;
        }
        return undefined;
    }, [params.scope]);

    React.useEffect(() => {
        if (auth.isAuthenticated) {
            setHydrationAttempted(true);
            return;
        }
        if (hydrationAttempted) {
            return;
        }

        let canceled = false;
        Promise.resolve(auth.refreshFromActiveServer?.())
            .catch(() => {})
            .finally(() => {
                if (canceled) return;
                setHydrationAttempted(true);
            });
        return () => {
            canceled = true;
        };
    }, [auth.isAuthenticated, auth.refreshFromActiveServer, hydrationAttempted]);

    React.useEffect(() => {
        if (auth.isAuthenticated) {
            return;
        }
        if (!hydrationAttempted) {
            return;
        }
        clearPendingSetupIntent();
        router.replace('/');
    }, [auth.isAuthenticated, hydrationAttempted]);

    if (!auth.isAuthenticated) {
        return null;
    }

    const content = (
        <SetupWizardSurface
            testID="setupWizard.surface"
            isDesktopShell={isDesktopHost()}
            useOuterScrollContainer={true}
            onExit={() => {
                applyLocalSettings({ sessionGettingStartedGuidanceDismissed: true });
                router.replace('/');
            }}
            initialStepId={initialStepId}
            initialSetupAction={initialSetupAction}
            scope={scope}
        />
    );

    return (
        <BaseModal
            visible={true}
            showBackdrop={true}
            accessibilityLabel={t('setupOnboarding.screenTitle')}
            webPlacement={shouldTopAlignWebModal ? 'top' : undefined}
            onClose={() => {
                applyLocalSettings({ sessionGettingStartedGuidanceDismissed: true });
                router.replace('/');
            }}
        >
            {content}
        </BaseModal>
    );
}
