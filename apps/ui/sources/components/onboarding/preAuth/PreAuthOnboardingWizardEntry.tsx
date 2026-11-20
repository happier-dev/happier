import * as React from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
    useAuth,
} from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { accountDirectoryAuthClient } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import type { AccountDirectoryKeyLoginOutcome } from '@/components/account/auth/AccountDirectoryKeyLoginForm';
import { launchAccountServiceOAuthAuthentication } from '@/components/account/auth/accountServiceAuthenticationActions';
import type { WelcomeAuthenticationMethod } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import type { AccountContinuationIntent } from '@happier-dev/cli-common/accountService';
import { useWelcomeAuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import type { AccountServiceSelectionFormProps } from '@/components/account/auth/AccountServiceSelectionForm';
import { selectAccountServiceEndpoint } from '@/sync/ops/accountDirectory/selectAccountServiceEndpoint';
import { useIsLandscape } from '@/utils/platform/responsive';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';
import { trackAccountCreated } from '@/track';
import { t } from '@/text';
import { AUTHENTICATED_ACCOUNT_ENTRY_ROUTE } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';

import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import { OnboardingWizardSurfacePresentation } from '@/components/onboarding/surfaces/OnboardingWizardSurface';
import { useOnboardingWizardController } from '@/components/onboarding/surfaces/useOnboardingWizardController';
import type { WelcomeAuthenticationActionContext } from '@/components/onboarding/surfaces/useOnboardingWizardController';
import { UnauthenticatedSplitShell, useApplyBrandHeroSeen } from '@/components/onboarding/unauthShell';
import { DesktopShellWindowControlsHost } from '@/components/navigation/shell/desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from '@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls';
import { UpdatesEntry } from '@/components/updates/UpdatesPopoverButton';
import { resolveAppShellChromeHost } from '@/components/appShell/resolveAppShellChromeHost';
import { resolveWizardAuthReturnToRoute } from '@/components/onboarding/state/wizardResume';
import { getWizardStepDefinition } from '@/components/onboarding/state/wizardStepRegistry';
import type { WizardStepId } from '@/components/onboarding/state/wizardTypes';
import { executeHomeAuthentication } from '@/auth/flows/executeHomeAuthentication';
import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { completeEmailPasswordAuthentication } from '@/components/account/auth/emailPassword/completeEmailPasswordAuthentication';
import {
    ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT,
    openAccountSecurityForHome,
} from '@/components/settings/account/openAccountSecurityForHome';
import { readWebServerEntry } from '@/sync/domains/server/serverProfiles';
import { consumeWebServerUrlOverrideFromLocation } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';

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
    if (!process.env.EXPO_PUBLIC_DEBUG || Platform.OS !== 'web') return '';
    const location =
        typeof window !== 'undefined'
            ? window.location
            : (globalThis as unknown as { location?: { href?: unknown; search?: unknown } }).location;
    const search = typeof location?.search === 'string' ? location.search : '';
    const href = typeof location?.href === 'string' ? location.href : '';
    const query = search || (href.includes('?') ? href.slice(href.indexOf('?')) : '');
    if (!query) return '';
    const value = new URLSearchParams(query).get(name);
    return typeof value === 'string' ? value.trim() : '';
}

export const PreAuthOnboardingWizardEntry = React.memo(function PreAuthOnboardingWizardEntry(props: PreAuthOnboardingWizardEntryProps) {
    const auth = useAuth();
    const router = useRouter();
    const { step } = useLocalSearchParams<{ step?: string | string[] }>();
    const homeStepRequested = (Array.isArray(step) ? step[0] : step) === 'home';
    const suppliedHomeAddress = React.useMemo(() => readWebServerEntry(), []);
    const clearSuppliedHomeAddress = React.useCallback(() => {
        if (suppliedHomeAddress) consumeWebServerUrlOverrideFromLocation({ serverUrl: suppliedHomeAddress.serverUrl, retainSelection: true });
    }, [suppliedHomeAddress]);
    const isLandscape = useIsLandscape();
    const isDesktopShell = React.useMemo(() => isDesktopHost(), []);
    const { authEntryOptions, accountServiceEntry } = useWelcomeAuthEntryOptions();
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
        // controller the auth-entry surface embeds, as its next workflow step.
        if (outcome.kind !== 'no_effect' || outcome.reason !== 'delegated_email_password') return;
        if (request.authority.purpose !== 'home' || request.execution.kind !== 'email_password') return;
        const resolvedTarget = resolveHomeAuthenticationTarget(request.authority.target);
        if (!resolvedTarget || context.signal.aborted) return;
        const execution = request.execution;
        context.presentEmailPassword({
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
            // Welcome has no other mounted step behind this one, so a Connect
            // whose exact-Home activation is blocked has nowhere to report it.
            // The step owns that arrival: it stays with the shared focus-only
            // retry and leaves only once Account Security is reached.
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
        if (suppliedHomeAddress && !suppliedHomeAddress.isAdmitted) return 'connect_home';
        if (homeStepRequested) return 'relay_select';
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
    }, [homeStepRequested, props.initialStepId, suppliedHomeAddress]);

    // Window controls stay in the top-left chrome where the platform puts them; the Updates entry is the
    // workflow pane's bottom-right footer control (end of the welcome help row, same corner on later steps).
    const shellChrome = shellChromeHost === 'unauth-shell' ? (
        <DesktopShellWindowControlsHost>
            {resolvedDesktopWindowControls}
        </DesktopShellWindowControlsHost>
    ) : null;
    const workflowFooterAccessory = shellChromeHost === 'unauth-shell'
        ? <UpdatesEntry variant="footer" testID="preauth-updates-entry" />
        : null;

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
        initialServerUrl: suppliedHomeAddress && !suppliedHomeAddress.isAdmitted ? suppliedHomeAddress.serverUrl : undefined,
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
    const shellTestID = props.testID ?? resolveUnauthShellRouteTestId(controller.stepId);
    const renderClassicShell = (children: React.ReactNode) => (
        <UnauthenticatedSplitShell
            stepId={controller.stepId}
            isWelcomeStep={controller.stepId === 'welcome'}
            allowMobileBrandHero={controller.stepId === 'welcome'}
            retentionDisclosure={authEntryOptions.retentionDisclosure}
            onBrandHeroGetStarted={applyBrandHeroSeen}
            onBack={controller.onBack ?? undefined}
            footerAccessory={workflowFooterAccessory}
            testID={shellTestID}
        >
            {children}
        </UnauthenticatedSplitShell>
    );

    return renderClassicShell(wizardFallback);
});
