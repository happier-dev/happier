import { useAuth } from "@/auth/context/AuthContext";
import { Platform, Linking, View } from 'react-native';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/flows/getToken";
import { router, useRouter, useLocalSearchParams } from "expo-router";
import { getRandomBytesAsync } from "@/platform/cryptoRandom";
import { useIsLandscape } from "@/utils/platform/responsive";
import { trackAccountCreated } from '@/track';
import { MainView } from "@/components/navigation/shell/MainView";
import { t } from '@/text';
import { TokenStorage } from "@/auth/storage/tokenStorage";
import sodium from '@/encryption/libsodium.lib';
import { getAuthProvider } from "@/auth/providers/registry";
import { Modal } from "@/modal";
import { BaseModal } from "@/modal/components/BaseModal";
import { getPendingTerminalConnect } from "@/sync/domains/pending/pendingTerminalConnect";
import { isSafeExternalAuthUrl } from "@/auth/providers/externalAuthUrl";
import { fireAndForget } from "@/utils/system/fireAndForget";
import { formatOperationFailedDebugMessage } from "@/utils/errors/formatOperationFailedDebugMessage";
import { getActiveServerSnapshot } from "@/sync/domains/server/serverRuntime";
import { buildDataKeyCredentialsForToken } from "@/auth/flows/buildDataKeyCredentialsForToken";
import { digest } from "@/platform/digest";
import { encodeHex } from "@/encryption/hex";
import { resolveAppUrlScheme } from "@/utils/url/appScheme";
import { readConfiguredServerUrlEnv } from "@/sync/domains/server/readConfiguredServerUrlEnv";
import { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } from "@/sync/domains/pending/pendingSetupIntent";
import { isTauriDesktop } from "@/utils/platform/tauri";
import { isAuthenticatedRootDeepLinkRedirectAllowed } from "@/auth/routing/isAuthenticatedRootDeepLinkRedirectAllowed";
import { resolvePostAuthSetupRoute } from "@/components/onboardingWizard/wizardResume";
import { PreAuthOnboardingWizardEntry } from "@/components/onboardingWizard/PreAuthOnboardingWizardEntry";
import { SetupWizardSurface } from "@/components/onboardingWizard/SetupWizardSurface";
import { useConnectionHealth } from "@/components/navigation/connectionStatus/useConnectionHealth";
import { useLocalDaemonControl } from "@/components/settings/machines/localControl/useLocalDaemonControl";
import { useRelayDriftBanner } from "@/components/settings/server/useRelayDriftBanner";

const stylesheet = StyleSheet.create({
    root: {
        flex: 1,
        position: 'relative',
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 100000,
    },
});

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <PreAuthOnboardingWizardEntry enableFirstLaunchSetupRedirect />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    const params = useLocalSearchParams<{ id?: string | string[]; messageId?: string | string[]; jumpChildId?: string | string[] }>();
    const router = useRouter();
    const connectionHealth = useConnectionHealth();
    const localDaemonControl = useLocalDaemonControl();
    const relayDriftBanner = useRelayDriftBanner();
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
        dismissPendingSetupIntent();
    }, [dismissPendingSetupIntent]);

    return (
        <View style={stylesheet.root}>
            <MainView variant="phone" />
            {setupWizardVisible ? (
                Platform.OS === 'web' ? (
                    <BaseModal
                        visible
                        scrollable
                        showBackdrop
                        closeOnBackdrop={false}
                        disableContentTransform
                        onClose={handleSetupWizardExit}
                    >
                        <SetupWizardSurface
                            isDesktopShell={isTauriDesktop()}
                            useOuterScrollContainer={true}
                            onExit={handleSetupWizardExit}
                        />
                    </BaseModal>
                ) : (
                    <View style={stylesheet.overlay}>
                        <SetupWizardSurface
                            isDesktopShell={isTauriDesktop()}
                            onExit={handleSetupWizardExit}
                        />
                    </View>
                )
            ) : null}
        </View>
    );
}
