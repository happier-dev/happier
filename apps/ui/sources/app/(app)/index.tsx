import { useAuth } from '@/auth/context/AuthContext';
import { View } from 'react-native';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, useGlobalSearchParams } from 'expo-router';
import { MainView } from '@/components/navigation/shell/MainView';
import { BaseModal } from '@/modal/components/BaseModal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { resolvePostAuthSetupRoute, PreAuthOnboardingWizardEntry } from '@/components/onboarding';
import { SetupWizardSurface } from '@/components/onboarding/surfaces/SetupWizardSurface';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { isAuthenticatedRootDeepLinkRedirectAllowed } from '@/auth/routing/authenticatedRootDeepLinkRedirectAllowed';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { shouldHoldUnauthenticatedShellForWebServerOverride } from '@/sync/domains/server/url/shouldHoldUnauthenticatedShellForWebServerOverride';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';

const stylesheet = StyleSheet.create({
    root: {
        flex: 1,
        position: 'relative',
    },
});

function normalizeQueryParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0].trim() : '';
    }
    return typeof value === 'string' ? value.trim() : '';
}

function readVoiceE2eFixtureIdFromLocation(): string {
    if (typeof window === 'undefined') return '';
    try {
        const current = new URL(window.location.href);
        return (current.searchParams.get('happier_voice_e2e_fixture') ?? '').trim();
    } catch {
        return '';
    }
}

function readVoiceE2eFixtureIdFromStorage(): string {
    const storage =
        typeof globalThis !== 'undefined' && typeof (globalThis as any).localStorage?.getItem === 'function'
            ? (globalThis as any).localStorage as Storage
            : null;
    if (!storage) return '';
    try {
        return String(storage.getItem('happier.voice.e2e.fixture') ?? '').trim();
    } catch {
        return '';
    }
}

export default function Home() {
    const auth = useAuth();
    const activeServerSnapshot = useActiveServerSnapshot();
    const params = useGlobalSearchParams<{ happier_voice_e2e_fixture?: string | string[] }>();
    const shouldSuppressFirstLaunchSetupRedirect = Boolean(
        normalizeQueryParam(params.happier_voice_e2e_fixture) || readVoiceE2eFixtureIdFromLocation() || readVoiceE2eFixtureIdFromStorage(),
    );
    if (!auth.isAuthenticated) {
        if (shouldHoldUnauthenticatedShellForWebServerOverride(auth.isAuthenticated, activeServerSnapshot.serverUrl)) {
            return null;
        }
        return <PreAuthOnboardingWizardEntry enableFirstLaunchSetupRedirect={!shouldSuppressFirstLaunchSetupRedirect} />;
    }
    return (
        <Authenticated />
    );
}

function Authenticated() {
    const params = useGlobalSearchParams<{
        id?: string | string[];
        messageId?: string | string[];
        jumpChildId?: string | string[];
        serverId?: string | string[];
        happier_voice_e2e_fixture?: string | string[];
    }>();
    const router = useRouter();
    const connectionHealth = useConnectionHealth();
    const localDaemonControl = useLocalDaemonControl();
    const relayDriftBanner = useRelayDriftBanner();
    const applyLocalSettings = useApplyLocalSettings();
    const [setupWizardVisible, setSetupWizardVisible] = React.useState(false);

    const sessionId = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? (params.id[0] ?? null) : null;
    const messageId = typeof params.messageId === 'string' ? params.messageId : Array.isArray(params.messageId) ? (params.messageId[0] ?? null) : null;
    const jumpChildId = typeof params.jumpChildId === 'string' ? params.jumpChildId : Array.isArray(params.jumpChildId) ? (params.jumpChildId[0] ?? null) : null;
    const voiceE2eFixtureId =
        typeof params.happier_voice_e2e_fixture === 'string'
            ? params.happier_voice_e2e_fixture
            : Array.isArray(params.happier_voice_e2e_fixture)
                ? (params.happier_voice_e2e_fixture[0] ?? null)
                : null;
    const shouldSuppressAutoOpenSetupWizard = Boolean(
        String(voiceE2eFixtureId ?? '').trim()
        || readVoiceE2eFixtureIdFromLocation()
        || readVoiceE2eFixtureIdFromStorage(),
    );
    const sessionRouteServerScope = createSessionRouteServerScope(params);
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
    const pendingTerminalConnect = getPendingTerminalConnect();
    const pendingSetupIntentDismissed = pendingSetupIntent?.phase === 'dismissed';
    const hasPendingSetupContinuation =
        pendingSetupIntent?.phase === 'awaiting_auth'
        || pendingSetupIntent?.phase === 'post_auth';
    const hasPendingTerminalConnectApproval = pendingTerminalConnect != null;
    const shouldSkipSetupWizardBecauseAnotherMachineIsOnline =
        isTauriDesktop() !== true
        && (connectionHealth.onlineCount ?? 0) > 0;
    const shouldAutoOpenSetupWizard = shouldSuppressAutoOpenSetupWizard
        ? false
        : isTauriDesktop()
            ? (!currentMachineIsConfiguredAndHealthy || hasRelayDrift)
            : (connectionHealth.onlineCount ?? 0) === 0;
    const needsSetupWizard =
        !hasPendingTerminalConnectApproval
        && shouldSuppressAutoOpenSetupWizard !== true
        &&
        pendingSetupIntentDismissed !== true
        && shouldSkipSetupWizardBecauseAnotherMachineIsOnline !== true
        && (hasPendingSetupContinuation || shouldAutoOpenSetupWizard);

    React.useEffect(() => {
        if (!shouldSuppressAutoOpenSetupWizard) return;
        if (setupWizardVisible) {
            setSetupWizardVisible(false);
        }
        if (!pendingSetupIntent) return;
        if (pendingSetupIntent.phase === 'dismissed') return;
        setPendingSetupIntent({ ...pendingSetupIntent, phase: 'dismissed' });
    }, [pendingSetupIntent, setupWizardVisible, shouldSuppressAutoOpenSetupWizard]);

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
        const sid = normalizeSessionId(sessionId);
        if (!sid) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;

        const mid = String(messageId ?? '').trim();
        if (mid) {
            const child = String(jumpChildId ?? '').trim();
            router.replace(sessionRouteServerScope.buildHref(sid, {
                suffix: `/message/${encodeURIComponent(mid)}`,
                query: child ? { jumpChildId: child } : undefined,
            }));
            return;
        }

        const child = String(jumpChildId ?? '').trim();
        router.replace(sessionRouteServerScope.buildHref(sid, {
            query: child ? { jumpChildId: child } : undefined,
        }));
    }, [jumpChildId, messageId, router, sessionId, sessionRouteServerScope]);

    React.useEffect(() => {
        const sid = normalizeSessionId(sessionId);
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
