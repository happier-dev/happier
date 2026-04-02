import { useAuth } from '@/auth/context/AuthContext';
import { View } from 'react-native';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MainView } from '@/components/navigation/shell/MainView';
import { BaseModal } from '@/modal/components/BaseModal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { resolvePostAuthSetupRoute, PreAuthOnboardingWizardEntry } from '@/components/onboarding';
import { SetupWizardSurface } from '@/components/onboarding/surfaces/SetupWizardSurface';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { isAuthenticatedRootDeepLinkRedirectAllowed } from '@/auth/routing/authenticatedRootDeepLinkRedirectAllowed';

const stylesheet = StyleSheet.create({
    root: {
        flex: 1,
        position: 'relative',
    },
});

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <PreAuthOnboardingWizardEntry enableFirstLaunchSetupRedirect />;
    }
    return (
        <Authenticated />
    );
}

function Authenticated() {
    const params = useLocalSearchParams<{ id?: string | string[]; messageId?: string | string[]; jumpChildId?: string | string[] }>();
    const router = useRouter();
    const connectionHealth = useConnectionHealth();
    const localDaemonControl = useLocalDaemonControl();
    const relayDriftBanner = useRelayDriftBanner();
    const applyLocalSettings = useApplyLocalSettings();
    const [setupWizardVisible, setSetupWizardVisible] = React.useState(false);

    const sessionId = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? (params.id[0] ?? null) : null;
    const messageId = typeof params.messageId === 'string' ? params.messageId : Array.isArray(params.messageId) ? (params.messageId[0] ?? null) : null;
    const jumpChildId = typeof params.jumpChildId === 'string' ? params.jumpChildId : Array.isArray(params.jumpChildId) ? (params.jumpChildId[0] ?? null) : null;
    const currentMachineIsConfiguredAndHealthy =
        localDaemonControl.status?.serviceInstalled === true
        && localDaemonControl.status?.daemonRunning === true
        && localDaemonControl.status?.needsAuth !== true
        && Boolean(localDaemonControl.status?.machineId);
    const hasRelayDrift = relayDriftBanner != null;
    const postAuthSetupRoute = resolvePostAuthSetupRoute({
        isDesktopShell: isTauriDesktop(),
        onlineMachineCount: connectionHealth.onlineCount,
        currentMachineIsConfiguredAndHealthy,
        hasRelayDrift,
    });
    const pendingSetupIntent = getPendingSetupIntent();
    const pendingSetupIntentDismissed = pendingSetupIntent?.phase === 'dismissed';
    const hasPendingSetupContinuation =
        pendingSetupIntent?.phase === 'awaiting_auth'
        || pendingSetupIntent?.phase === 'post_auth';
    const shouldSkipSetupWizardBecauseAnotherMachineIsOnline =
        isTauriDesktop() !== true
        && (connectionHealth.onlineCount ?? 0) > 0;
    const shouldAutoOpenSetupWizard = isTauriDesktop()
        ? (!currentMachineIsConfiguredAndHealthy || hasRelayDrift)
        : (connectionHealth.onlineCount ?? 0) === 0;
    const needsSetupWizard =
        pendingSetupIntentDismissed !== true
        && shouldSkipSetupWizardBecauseAnotherMachineIsOnline !== true
        && (hasPendingSetupContinuation || shouldAutoOpenSetupWizard);

    const dismissPendingSetupIntent = React.useCallback(() => {
        const current = getPendingSetupIntent();
        if (current) {
            if (current.phase !== 'dismissed') {
                setPendingSetupIntent({ ...current, phase: 'dismissed' });
            }
            return;
        }
        if (!shouldAutoOpenSetupWizard) {
            return;
        }
        const snapshot = getActiveServerSnapshot();
        const relayUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim().replace(/\/+$/, '') : null;
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: relayUrl || null,
        });
    }, [shouldAutoOpenSetupWizard]);

    React.useEffect(() => {
        const sid = String(sessionId ?? '').trim();
        if (!sid) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;

        const mid = String(messageId ?? '').trim();
        if (mid) {
            const child = String(jumpChildId ?? '').trim();
            const qs = child ? `?jumpChildId=${encodeURIComponent(child)}` : '';
            router.replace(`/session/${encodeURIComponent(sid)}/message/${encodeURIComponent(mid)}${qs}`);
            return;
        }

        router.replace(`/session/${encodeURIComponent(sid)}`);
    }, [jumpChildId, messageId, router, sessionId]);

    React.useEffect(() => {
        const sid = String(sessionId ?? '').trim();
        if (sid) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;

        if (setupWizardVisible) {
            return;
        }
        if (!needsSetupWizard) {
            if (postAuthSetupRoute === '/') {
                if (pendingSetupIntent?.phase !== 'dismissed') {
                    clearPendingSetupIntent();
                }
            }
            return;
        }

        if (pendingSetupIntent?.phase === 'awaiting_auth') {
            setPendingSetupIntent({
                ...pendingSetupIntent,
                phase: 'post_auth',
            });
        } else if (!pendingSetupIntent && shouldAutoOpenSetupWizard) {
            const snapshot = getActiveServerSnapshot();
            const relayUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim().replace(/\/+$/, '') : null;
            setPendingSetupIntent({
                branch: 'thisComputer',
                phase: 'post_auth',
                relayUrl: relayUrl || null,
            });
        }

        setSetupWizardVisible(true);
    }, [needsSetupWizard, pendingSetupIntent, postAuthSetupRoute, sessionId, setupWizardVisible, shouldAutoOpenSetupWizard]);

    const handleSetupWizardExit = React.useCallback(() => {
        setSetupWizardVisible(false);
        applyLocalSettings({ sessionGettingStartedGuidanceDismissed: true });
        dismissPendingSetupIntent();
    }, [applyLocalSettings, dismissPendingSetupIntent]);

    return (
        <View style={stylesheet.root}>
            <MainView variant="phone" />
            {setupWizardVisible ? (
                <BaseModal
                    visible
                    showBackdrop
                    closeOnBackdrop={false}
                    onClose={handleSetupWizardExit}
                >
                    <SetupWizardSurface
                        isDesktopShell={isTauriDesktop()}
                        useOuterScrollContainer={true}
                        onExit={handleSetupWizardExit}
                    />
                </BaseModal>
            ) : null}
        </View>
    );
}
