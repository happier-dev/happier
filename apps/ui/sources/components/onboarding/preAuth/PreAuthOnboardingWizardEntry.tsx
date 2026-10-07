import * as React from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    useAuth,
} from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { accountDirectoryAuthClient } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import type { AccountDirectoryKeyLoginOutcome } from '@/components/account/auth/AccountDirectoryKeyLoginForm';
import { launchAccountServiceOAuthAuthentication } from '@/components/account/auth/accountServiceAuthenticationActions';
import type { WelcomeAuthenticationMethod } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import type { AccountContinuationIntent } from '@happier-dev/cli-common/accountService';
import { useAuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { useAccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import type { AccountServiceSelectionFormProps } from '@/components/account/auth/AccountServiceSelectionForm';
import { selectAccountServiceEndpoint } from '@/sync/ops/accountDirectory/selectAccountServiceEndpoint';
import { useIsLandscape } from '@/utils/platform/responsive';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';
import { trackAccountCreated } from '@/track';
import { t } from '@/text';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { AUTHENTICATED_ACCOUNT_ENTRY_ROUTE } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';

import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { usePendingSetupIntent } from '@/components/onboarding/state/usePendingSetupIntent';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import { OnboardingWizardSurfacePresentation } from '@/components/onboarding/surfaces/OnboardingWizardSurface';
import { useOnboardingWizardController } from '@/components/onboarding/surfaces/useOnboardingWizardController';
import type { WelcomeAuthenticationActionContext } from '@/components/onboarding/surfaces/useOnboardingWizardController';
import { UnauthenticatedSplitShell, useApplyBrandHeroSeen } from '@/components/onboarding/unauthShell';
import { DesktopShellUpdateIndicatorHost } from '@/components/navigation/shell/desktopChrome/DesktopShellUpdateIndicatorHost';
import { DesktopShellWindowControlsHost } from '@/components/navigation/shell/desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from '@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls';
import { UpdatesEntry } from '@/components/updates/UpdatesPopoverButton';
import { resolveAppShellChromeHost } from '@/components/appShell/resolveAppShellChromeHost';
import { resolveWizardAuthReturnToRoute } from '@/components/onboarding/state/wizardResume';
import { getWizardStepDefinition } from '@/components/onboarding/state/wizardStepRegistry';
import type { WizardStepId } from '@/components/onboarding/state/wizardTypes';
import { type JourneyBeatId, type JourneySurface } from '@/components/onboarding/tour/state/journeyBeats';
import { readJourneyReplayBeatId, readWebQueryParam } from '@/components/onboarding/tour/state/journeyReplayIntent';
import { useOnboardingJourneySessionActive } from '@/components/onboarding/tour/state/journeySession';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { useLocalSetting } from '@/sync/store/hooks';
import { executeHomeAuthentication } from '@/auth/flows/executeHomeAuthentication';
import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { presentEmailPasswordAuthentication } from '@/components/account/auth/emailPassword/presentEmailPasswordAuthentication';
import { completeEmailPasswordAuthentication } from '@/components/account/auth/emailPassword/completeEmailPasswordAuthentication';
import {
    ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT,
    openAccountSecurityForHome,
} from '@/components/settings/account/openAccountSecurityForHome';
import { consumeWebServerUrlOverrideFromLocation, readWebServerUrlOverrideFromLocation } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { useOpenPersonalize } from '@/components/onboarding/personalize/useOpenPersonalize';
import type { JourneyCompletion } from '@/components/onboarding/tour/state/useJourneyProgress';

type OnboardingJourneyHostModule = typeof import('@/components/onboarding/tour/OnboardingJourneyHost');
let onboardingJourneyHostModulePromise: Promise<OnboardingJourneyHostModule> | null = null;

function loadOnboardingJourneyHostModule(): Promise<OnboardingJourneyHostModule> {
    onboardingJourneyHostModulePromise ??= import('@/components/onboarding/tour/OnboardingJourneyHost');
    return onboardingJourneyHostModulePromise;
}

export function preloadOnboardingJourneyHost(): void {
    void loadOnboardingJourneyHostModule();
}

const LazyOnboardingJourneyHost = React.lazy(async () => {
    const module = await loadOnboardingJourneyHostModule();
    return { default: module.OnboardingJourneyHost };
});

const journeyLoadingStylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.background.canvas,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.margins.md,
        paddingHorizontal: theme.margins.xxl,
    },
    label: {
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));

function OnboardingJourneyLoadingSurface(): React.ReactElement {
    const { theme } = useUnistyles();
    const loadingLabel = t('common.loading');

    return (
        <View
            testID="onboarding-journey-loading"
            accessible
            accessibilityLabel={loadingLabel}
            accessibilityRole="progressbar"
            accessibilityLiveRegion="polite"
            role="status"
            aria-live="polite"
            style={journeyLoadingStylesheet.root}
        >
            <ActivitySpinner
                testID="onboarding-journey-loading-spinner"
                color={theme.colors.text.secondary}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            />
            <Text testID="onboarding-journey-loading-label" style={journeyLoadingStylesheet.label}>
                {loadingLabel}
            </Text>
        </View>
    );
}

type JourneyHostErrorBoundaryProps = Readonly<{
    children: React.ReactNode;
    fallback: React.ReactNode;
}>;

type JourneyHostErrorBoundaryState = Readonly<{
    didCatch: boolean;
}>;

class JourneyHostErrorBoundary extends React.Component<JourneyHostErrorBoundaryProps, JourneyHostErrorBoundaryState> {
    state: JourneyHostErrorBoundaryState = { didCatch: false };

    static getDerivedStateFromError(): JourneyHostErrorBoundaryState {
        return { didCatch: true };
    }

    render(): React.ReactNode {
        if (this.state.didCatch) {
            return this.props.fallback;
        }
        return this.props.children;
    }
}

export type PreAuthOnboardingWizardEntryProps = Readonly<{
    testID?: string;
    clearPendingSetupIntentOnMount?: boolean;
    initialStepId?: WizardStepId;
}>;

function resolveAuthReturnToRoute(): string {
    return resolveWizardAuthReturnToRoute();
}

function resolveUnauthShellRouteTestId(stepId: WizardStepId): string {
    if (stepId === 'auth_restore') return 'unauth-shell-route-restore';
    if (stepId === 'relay_select') return 'unauth-shell-route-setup-pre-auth';
    return 'unauth-shell-route-welcome';
}

function readDebugWebQueryParam(name: string): string {
    if (!process.env.EXPO_PUBLIC_DEBUG) return '';
    return readWebQueryParam(name);
}

function resolveJourneySurface(params: Readonly<{ isDesktopShell: boolean; platformOs: string }>): JourneySurface {
    if (params.isDesktopShell) return 'desktop';
    return params.platformOs === 'web' ? 'web' : 'native';
}

export const PreAuthOnboardingWizardEntry = React.memo(function PreAuthOnboardingWizardEntry(props: PreAuthOnboardingWizardEntryProps) {
    const auth = useAuth();
    const router = useRouter();
    const openPersonalize = useOpenPersonalize();
    const suppliedHomeAddress = React.useMemo(() => readWebServerUrlOverrideFromLocation(), []);
    const clearSuppliedHomeAddress = React.useCallback(() => {
        if (suppliedHomeAddress) consumeWebServerUrlOverrideFromLocation({ serverUrl: suppliedHomeAddress.serverUrl });
    }, [suppliedHomeAddress]);
    const onboardingTourDecision = useFeatureDecision('app.ui.onboardingTour', { scopeKind: 'runtime' });
    const onboardingTourEnabled = onboardingTourDecision?.state === 'enabled';
    const onboardingTourResolving = onboardingTourDecision == null;
    // The journey is a FIRST-RUN experience (D21). `hasCompletedAuthOnce` survives
    // logout by design, so returning users get the preserved classic welcome shell.
    const hasCompletedAuthOnce = useLocalSetting('hasCompletedAuthOnce') === true;
    // Sticky: once a journey session is live it OWNS the viewport until it ends.
    // This flag flips true when the host mounts and stays true across the auth hinge
    // (login sets `hasCompletedAuthOnce`), so a first-run journey is never torn down
    // mid-setup — the root cause of the S4-beside-the-live-shell composition defect.
    const journeySessionActive = useOnboardingJourneySessionActive();
    // A persisted setup-intent continuation for an authed user means the journey's
    // setup act was interrupted (e.g. reload lost the in-memory session latch). The
    // journey re-latches at the setup act instead of ever exposing the shell (D21/P1).
    const routeGatePendingSetupIntent = usePendingSetupIntent();
    const hasAuthedSetupContinuation =
        auth.isAuthenticated
        && (routeGatePendingSetupIntent?.phase === 'awaiting_auth' || routeGatePendingSetupIntent?.phase === 'post_auth');
    const isLandscape = useIsLandscape();
    const isDesktopShell = React.useMemo(() => isDesktopHost(), []);
    const authEntryOptions = useAuthEntryOptions();
    const accountServiceTargetContext = React.useMemo(() => authEntryOptions.requestedHomeTarget ? ({
        kind: 'home' as const,
        target: authEntryOptions.requestedHomeTarget,
        ...(authEntryOptions.signInServicePolicy ? { policy: authEntryOptions.signInServicePolicy } : {}),
        selfService: {
            endpointUrl: authEntryOptions.serverUrlForCopy,
            ...(authEntryOptions.observedHomeServerIdentityId
                ? { expectedServerIdentityId: authEntryOptions.observedHomeServerIdentityId }
                : {}),
            ...authEntryOptions.homeTransport,
        },
    }) : ({ kind: 'none' as const }), [
        authEntryOptions.requestedHomeTarget,
        authEntryOptions.homeTransport,
        authEntryOptions.observedHomeServerIdentityId,
        authEntryOptions.serverUrlForCopy,
        authEntryOptions.signInServicePolicy,
    ]);
    // The selected sign-in service is resolved independently of the focused Home, so a fresh
    // device with zero Home profiles still reaches its advertised sign-in methods.
    const accountServiceEntry = useAccountServiceEntryOptions(accountServiceTargetContext);
    const selectAccountService = React.useCallback<AccountServiceSelectionFormProps['onSelect']>(async (entered, options) => {
        return await selectAccountServiceEndpoint(entered, options);
    }, []);
    const accountContinuationIntent = React.useMemo<AccountContinuationIntent>(() => (
        authEntryOptions.requestedHomeTarget && authEntryOptions.observedHomeServerIdentityId
            ? { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: authEntryOptions.observedHomeServerIdentityId } }
            : { kind: 'enter', target: { kind: 'automatic' } }
    ), [authEntryOptions.observedHomeServerIdentityId, authEntryOptions.requestedHomeTarget]);
    const applyBrandHeroSeen = useApplyBrandHeroSeen();
    const shellChromeHost = resolveAppShellChromeHost({
        isAuthenticated: false,
        isDesktopHost: isDesktopShell,
        isTablet: false,
        isTerminalConnectRoute: false,
    });
    const resolvedDesktopWindowControls = useResolvedDesktopWindowControls({
        variant: 'expanded',
    });

    React.useEffect(() => {
        if (!props.clearPendingSetupIntentOnMount) {
            return;
        }
        clearPendingSetupIntent();
    }, [props.clearPendingSetupIntentOnMount]);

    /**
     * Unauthenticated Welcome sign-in against the selected sign-in service (A7 / G02-2).
     *
     * Every fact comes from the service's own advertisement: the immutable endpoint URL, its
     * observed stable identity, and its canonical audience. The focused Home is never read, the
     * ordinary Home OAuth custody namespace is never written, and no Home runtime is constructed.
     */
    const continueWithAccountServiceProvider = React.useCallback(async (request: WelcomeAuthenticationMethod, context: WelcomeAuthenticationActionContext) => {
        if (request.authority.purpose !== 'account_service' || request.execution.kind !== 'oauth') return;
        const service = request.authority.service;
        const currentDiscovery = accountServiceEntry.discovery;
        if (accountServiceEntry.status !== 'ready' || !currentDiscovery
            || currentDiscovery.endpointUrl !== service.endpointUrl
            || currentDiscovery.serverIdentityId !== service.serverIdentityId) return;
        const outcome = await launchAccountServiceOAuthAuthentication({
            authority: service,
            execution: request.execution,
            intent: accountContinuationIntent,
            returnTo: AUTHENTICATED_ACCOUNT_ENTRY_ROUTE,
            accountEntryReturnTo: resolveAuthReturnToRoute(),
            transport: accountServiceEntry.transport,
            signal: context.signal,
        });
        if (outcome === 'failed') {
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    }, [accountContinuationIntent, accountServiceEntry]);

    const continueWithHomeAuthentication = React.useCallback(async (request: WelcomeAuthenticationMethod, context: WelcomeAuthenticationActionContext) => {
        const outcome = await executeHomeAuthentication({
            request,
            loginWithCredentials: auth.loginWithCredentials,
            returnTo: resolveAuthReturnToRoute(),
            ...(authEntryOptions.homeTransport ? { transport: authEntryOptions.homeTransport } : {}),
            signal: context.signal,
            keyChallengeV2Available: authEntryOptions.keyChallengeV2Available,
            retryServerCheck: authEntryOptions.retryServerCheck,
            onProvisioned: trackAccountCreated,
        });
        // Every native email/password action owns a controller the generic
        // helper deliberately refuses to run. Welcome hosts the same shared
        // controller the auth-entry surface embeds rather than reimplementing it.
        if (outcome.kind !== 'no_effect' || outcome.reason !== 'delegated_email_password') return;
        if (request.authority.purpose !== 'home' || request.execution.kind !== 'email_password') return;
        const resolvedTarget = resolveHomeAuthenticationTarget(request.authority.target);
        if (!resolvedTarget || context.signal.aborted) return;
        const execution = request.execution;
        presentEmailPasswordAuthentication({
            target: {
                ...resolvedTarget,
                ...(authEntryOptions.homeTransport?.runtimeOrigin
                    ? { runtimeOrigin: authEntryOptions.homeTransport.runtimeOrigin }
                    : {}),
                ...(authEntryOptions.homeTransport?.homeCarrier
                    ? { homeCarrier: authEntryOptions.homeTransport.homeCarrier }
                    : {}),
            },
            recoveryTarget: resolvedTarget.serverIdentityId,
            action: execution.action,
            mode: execution.mode,
            ...(execution.recommendedProvisionMode ? { recommendedProvisionMode: execution.recommendedProvisionMode } : {}),
            ...(execution.passwordReset ? { passwordReset: execution.passwordReset } : {}),
            ...(authEntryOptions.homeLabel ? { homeLabel: authEntryOptions.homeLabel } : {}),
            signal: context.signal,
            // Welcome has no mounted step of its own behind this modal, so a
            // Connect whose exact-Home activation is blocked has nowhere to report
            // it. The modal owns that arrival: it stays open with the shared
            // focus-only retry and closes only once Account Security is reached.
            ...(execution.action === 'connect'
                ? {
                    reachExactHome: async () => await openAccountSecurityForHome({
                        serverId: resolvedTarget.serverId ?? resolvedTarget.serverIdentityId,
                        router,
                        refreshAuth: auth.refreshFromActiveServer,
                        intent: ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT,
                    }),
                }
                : {}),
            onAuthenticated: async (result) => {
                return await completeEmailPasswordAuthentication({
                    outcome: result,
                    target: {
                        serverUrl: resolvedTarget.canonicalServerUrl,
                        serverId: resolvedTarget.serverId ?? resolvedTarget.serverIdentityId,
                    },
                    signal: context.signal,
                    loginWithCredentials: auth.loginWithCredentials,
                    onCompleted: async () => {
                        if (execution.action === 'provision') await trackAccountCreated();
                    },
                });
            },
        });
    }, [auth.loginWithCredentials, auth.refreshFromActiveServer, authEntryOptions.homeLabel, authEntryOptions.homeTransport, authEntryOptions.keyChallengeV2Available, authEntryOptions.retryServerCheck, router]);

    const resolvedInitialStepId = React.useMemo((): WizardStepId | undefined => {
        if (props.initialStepId) {
            return props.initialStepId;
        }
        if (suppliedHomeAddress) return 'relay_enter_url';
        const candidate = readDebugWebQueryParam('happier_wizard_step');
        if (!candidate) {
            return undefined;
        }

        try {
            getWizardStepDefinition(candidate as WizardStepId);
            return candidate as WizardStepId;
        } catch {
            return undefined;
        }
    }, [props.initialStepId, suppliedHomeAddress]);

    const resolvedInitialBeatId = React.useMemo((): JourneyBeatId | undefined => (
        readJourneyReplayBeatId()
    ), []);
    const handleJourneyExit = React.useCallback((completion?: JourneyCompletion) => {
        if (!auth.isAuthenticated) return;
        // A replay URL is a continuing viewport intent; retire it before the phone sheet opens.
        if (resolvedInitialBeatId) router.replace('/');
        if (completion) openPersonalize();
    }, [auth.isAuthenticated, openPersonalize, resolvedInitialBeatId, router]);

    const shellChrome = shellChromeHost === 'unauth-shell' ? (
        <>
            <DesktopShellWindowControlsHost>
                {resolvedDesktopWindowControls}
            </DesktopShellWindowControlsHost>
            <DesktopShellUpdateIndicatorHost>
                <UpdatesEntry variant="pill" testID="preauth-updates-pill" />
            </DesktopShellUpdateIndicatorHost>
        </>
    ) : null;

    const wizardSurfaceProps = {
        testID: props.testID ?? 'onboarding-wizard',
        layout: isLandscape ? 'landscape' as const : 'portrait' as const,
        isDesktopShell,
        wizardChromeMode: 'bare' as const,
        wizardLayoutPresentation: isDesktopShell ? 'fullscreen' as const : undefined,
        authEntryOptions,
        accountServiceEntry,
        accountContinuationIntent,
        accountEntryReturnTo: resolveAuthReturnToRoute(),
        shellChrome,
        initialStepId: resolvedInitialStepId,
        initialServerUrl: suppliedHomeAddress?.serverUrl,
        onInitialServerUrlConnected: suppliedHomeAddress ? clearSuppliedHomeAddress : undefined,
        onContinueWithAccountServiceProvider: continueWithAccountServiceProvider,
        onContinueWithHomeAuthentication: continueWithHomeAuthentication,
        onAccountDirectoryKeyResult: () => {},
        onSelectAccountService: selectAccountService,
    };

    const controller = useOnboardingWizardController(wizardSurfaceProps);
    const wizardFallback = (
        <OnboardingWizardSurfacePresentation
            {...wizardSurfaceProps}
            controller={controller}
        />
    );
    const journeyLoadingFallback = <OnboardingJourneyLoadingSurface />;
    const journeySurface = resolveJourneySurface({
        isDesktopShell,
        platformOs: Platform.OS,
    });
    const shellTestID = props.testID ?? resolveUnauthShellRouteTestId(controller.stepId);
    const renderClassicShell = (children: React.ReactNode) => (
        <UnauthenticatedSplitShell
            stepId={controller.stepId}
            isWelcomeStep={controller.stepId === 'welcome'}
            allowMobileBrandHero={controller.stepId === 'welcome'}
            retentionDisclosure={authEntryOptions.retentionDisclosure}
            onOpenRelayCustomFlow={() => {
                controller.goToStep('relay_select');
            }}
            onBrandHeroGetStarted={applyBrandHeroSeen}
            onBack={controller.onBack ?? undefined}
            transitionDirection={controller.contentTransitionDirection}
            workflowPresentation={controller.stepId === 'scan_code' ? 'fullBleed' : 'padded'}
            testID={shellTestID}
        >
            {children}
        </UnauthenticatedSplitShell>
    );

    if (onboardingTourResolving && !suppliedHomeAddress) {
        return journeyLoadingFallback;
    }

    // Explicit replay intent (deep-link into a specific journey beat) reaches the
    // journey regardless of returning-user status; replay is an intent, not the default.
    const hasExplicitJourneyReplayIntent = resolvedInitialBeatId != null;
    const shouldRenderJourney =
        onboardingTourEnabled
        && !suppliedHomeAddress
        && (journeySessionActive || hasAuthedSetupContinuation || !hasCompletedAuthOnce || hasExplicitJourneyReplayIntent);
    // Re-latch case: authed setup continuation without a live journey session mounts
    // the host directly at the first setup-act beat (S3) instead of the journey start.
    const journeyInitialBeatId = resolvedInitialBeatId
        ?? (hasAuthedSetupContinuation && !journeySessionActive ? 'S3' as JourneyBeatId : undefined);

    if (shouldRenderJourney) {
        preloadOnboardingJourneyHost();
        const fallback = renderClassicShell(wizardFallback);
        return (
            <JourneyHostErrorBoundary fallback={fallback}>
                <React.Suspense fallback={journeyLoadingFallback}>
                    <LazyOnboardingJourneyHost
                        testID={props.testID ?? 'onboarding-journey'}
                        surface={journeySurface}
                        isDesktopShell={isDesktopShell}
                        initialBeatId={journeyInitialBeatId}
                        retentionDisclosure={authEntryOptions.retentionDisclosure}
                        preAuthController={controller}
                        wizardSurfaceProps={wizardSurfaceProps}
                        onExit={handleJourneyExit}
                    />
                </React.Suspense>
            </JourneyHostErrorBoundary>
        );
    }

    return renderClassicShell(wizardFallback);
});
