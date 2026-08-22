import { useAuth } from '@/auth/context/AuthContext';
import { View } from 'react-native';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, useGlobalSearchParams } from 'expo-router';
import { MainView } from '@/components/navigation/shell/MainView';
import { BaseModal } from '@/modal/components/BaseModal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { clearPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { buildDismissedThisComputerSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { PreAuthOnboardingWizardEntry } from '@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry';
import { usePendingSetupIntent } from '@/components/onboarding/state/usePendingSetupIntent';
import { useMachineSetupStepSatisfied } from '@/components/onboarding/state/useMachineSetupStepSatisfied';
import {
    doesOnboardingJourneyOwnTransientDemoServer,
    useOnboardingJourneySessionActive,
} from '@/components/onboarding/tour/state/journeySession';
import { readJourneyReplayBeatId } from '@/components/onboarding/tour/state/journeyReplayIntent';
import { SetupWizardSurface } from '@/components/onboarding/surfaces/SetupWizardSurface';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { isAuthenticatedRootDeepLinkRedirectAllowed } from '@/auth/routing/authenticatedRootDeepLinkRedirectAllowed';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { shouldHoldUnauthenticatedShellForWebServerOverride } from '@/sync/domains/server/url/shouldHoldUnauthenticatedShellForWebServerOverride';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useVoiceSurfaceE2eFixtureComposition } from '@/dev/testkit/harness/useVoiceSurfaceE2eFixtureComposition';
import { t } from '@/text';

const stylesheet = StyleSheet.create({
    root: {
        flex: 1,
        position: 'relative',
    },
});

export default function Home() {
    const auth = useAuth();
    const activeServerSnapshot = useActiveServerSnapshot();
    const onboardingJourneyActive = useOnboardingJourneySessionActive();
    const onboardingTourDecision = useFeatureDecision('app.ui.onboardingTour', { scopeKind: 'runtime' });
    const routeGatePendingSetupIntent = usePendingSetupIntent();
    // The post-auth machine-setup step is satisfied once the account has ANY machine (even
    // offline). Canonical owner: useMachineSetupStepSatisfied → useAllMachines().length > 0.
    const machineSetupStepSatisfied = useMachineSetupStepSatisfied();
    const voiceE2eFixture = useVoiceSurfaceE2eFixtureComposition();
    // D21/P1 composition invariant: with the journey flag ON, post-auth setup NEVER
    // renders beside the authenticated shell. The in-memory journey-session latch can
    // be lost (page reload, crash) while the persisted setup intent survives — in that
    // state the route hands the setup act back to the full-viewport journey host, which
    // re-latches on mount. The legacy in-shell wizard renders only when the flag is off.
    const hasPendingSetupContinuation =
        routeGatePendingSetupIntent?.phase === 'awaiting_auth'
        || routeGatePendingSetupIntent?.phase === 'post_auth';
    // Fail-closed: an unresolved decision is treated as disabled (legacy path).
    // Once the account already has a machine (even offline), the machine-setup step is
    // satisfied — the route never auto re-latches the full-viewport setup act; it falls
    // through to the authenticated shell, which settles the stale continuation intent.
    // This gates the AUTO re-latch only; a live journey session (onboardingJourneyActive)
    // is intentionally not gated, so a first machine arriving mid-S3 never yanks the step.
    const journeyOwnsSetupContinuation =
        auth.isAuthenticated
        && hasPendingSetupContinuation
        && onboardingTourDecision?.state === 'enabled'
        && !machineSetupStepSatisfied;
    // Explicit replay deep-link (`?happier_journey_beat=<id>`): a production entry
    // point for returning users. The entry owns the actual replay semantics; the
    // route gate only has to hand it the viewport instead of the authenticated shell.
    // Same fail-closed flag gating as the continuation path.
    const hasExplicitJourneyReplayIntent =
        onboardingTourDecision?.state === 'enabled'
        && readJourneyReplayBeatId() != null;
    if (!auth.isAuthenticated || onboardingJourneyActive || journeyOwnsSetupContinuation || hasExplicitJourneyReplayIntent) {
        // The URL override owns the real relay and must settle before first mount. Once the
        // journey has mounted, its demo world intentionally activates a temporary local
        // relay; treating that presentation-only server as override drift would unmount the
        // journey, restore the real relay, and reseed forever. Defer the hold only for this
        // exact live demo lifetime. True journey exit restores the pinned relay first, and a
        // genuinely different override remains pending for the normal route owner afterward.
        const activeJourneyOwnsTransientDemoServer =
            doesOnboardingJourneyOwnTransientDemoServer(onboardingJourneyActive);
        if (
            !activeJourneyOwnsTransientDemoServer
            && shouldHoldUnauthenticatedShellForWebServerOverride(auth.isAuthenticated, activeServerSnapshot.serverUrl)
        ) {
            return null;
        }
        return (
            <PreAuthOnboardingWizardEntry
                enableFirstLaunchSetupRedirect={!auth.isAuthenticated && !voiceE2eFixture.shouldSuppressOnboarding}
            />
        );
    }
    return (
        <Authenticated shouldSuppressAutoOpenSetupWizard={voiceE2eFixture.shouldSuppressOnboarding} />
    );
}

function Authenticated(props: Readonly<{ shouldSuppressAutoOpenSetupWizard: boolean }>) {
    const params = useGlobalSearchParams<{
        id?: string | string[];
        messageId?: string | string[];
        jumpChildId?: string | string[];
        serverId?: string | string[];
    }>();
    const router = useRouter();
    const localDaemonControl = useLocalDaemonControl();
    const relayDriftBanner = useRelayDriftBanner();
    const applyLocalSettings = useApplyLocalSettings();
    const [setupWizardVisible, setSetupWizardVisible] = React.useState(false);

    const sessionId = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? (params.id[0] ?? null) : null;
    const messageId = typeof params.messageId === 'string' ? params.messageId : Array.isArray(params.messageId) ? (params.messageId[0] ?? null) : null;
    const jumpChildId = typeof params.jumpChildId === 'string' ? params.jumpChildId : Array.isArray(params.jumpChildId) ? (params.jumpChildId[0] ?? null) : null;
    const shouldSuppressAutoOpenSetupWizard = props.shouldSuppressAutoOpenSetupWizard;
    const sessionRouteServerScope = createSessionRouteServerScope(params);
    const currentMachineIsConfiguredAndHealthy =
        localDaemonControl.status?.serviceInstalled === true
        && localDaemonControl.status?.daemonRunning === true
        && localDaemonControl.status?.needsAuth !== true
        && Boolean(localDaemonControl.status?.machineId);
    const hasRelayDrift = relayDriftBanner != null;
    const pendingSetupIntent = usePendingSetupIntent();
    const pendingTerminalConnect = getPendingTerminalConnect();
    const pendingSetupIntentDismissed = pendingSetupIntent?.phase === 'dismissed';
    const hasPendingSetupContinuation =
        pendingSetupIntent?.phase === 'awaiting_auth'
        || pendingSetupIntent?.phase === 'post_auth';
    const hasPendingTerminalConnectApproval = pendingTerminalConnect != null;
    // Binding decision: the machine-setup step auto-displays only while the account has ZERO
    // machines. Any machine (even offline) satisfies it — on EVERY platform, including the
    // desktop local-daemon-health auto-open — so the in-shell wizard never auto-opens again
    // and a stale pending continuation is settled (cleared below when !needsSetupWizard).
    // Explicit entry points (sessions empty-state, settings, journey replay) are not gated.
    const machineSetupStepSatisfied = useMachineSetupStepSatisfied();
    const shouldAutoOpenSetupWizard = shouldSuppressAutoOpenSetupWizard
        ? false
        : isDesktopHost()
            ? (!currentMachineIsConfiguredAndHealthy || hasRelayDrift)
            : true;
    const needsSetupWizard =
        !hasPendingTerminalConnectApproval
        && shouldSuppressAutoOpenSetupWizard !== true
        &&
        pendingSetupIntentDismissed !== true
        && machineSetupStepSatisfied !== true
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
        const current = pendingSetupIntent;
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
        setPendingSetupIntent(buildDismissedThisComputerSetupIntent(snapshot.serverUrl));
    }, [pendingSetupIntent, shouldAutoOpenSetupWizard]);

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
            if (pendingSetupIntent?.phase !== 'dismissed') {
                clearPendingSetupIntent();
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
    }, [needsSetupWizard, pendingSetupIntent, sessionId, setupWizardVisible, shouldAutoOpenSetupWizard]);

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
                    accessibilityLabel={t('setupOnboarding.screenTitle')}
                    closeOnBackdrop={false}
                    onClose={handleSetupWizardExit}
                >
                    <SetupWizardSurface
                        isDesktopShell={isDesktopHost()}
                        useOuterScrollContainer={true}
                        onExit={handleSetupWizardExit}
                    />
                </BaseModal>
            ) : null}
        </View>
    );
}
