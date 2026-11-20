import * as React from 'react';
import { Platform, View } from 'react-native';
import { router } from 'expo-router';
import { useRouter as useHomeRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import type { AccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import type { AccountServiceSelectionFormProps } from '@/components/account/auth/AccountServiceSelectionForm';
import type { AccountDirectoryKeyLoginOutcome } from '@/components/account/auth/AccountDirectoryKeyLoginForm';
import { shouldDismissAccountPostAuthContinuation, type AccountPostAuthInput, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import type { AccountContinuationIntent } from '@happier-dev/cli-common/accountService';
import type { WelcomeAuthenticationMethod } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import { Text } from '@/components/ui/text/Text';
import { ActiveRelaySummary } from '@/components/onboarding/ui/ActiveRelaySummary';
import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';
import type { WizardAction } from '../state/wizardTypes';
import { t } from '@/text';
import { Modal } from '@/modal';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

import { isSameServerUrl, normalizeServerUrl, setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readConfiguredServerUrlEnv } from '@/sync/domains/server/readConfiguredServerUrlEnv';
import { defaultHomeNameForAddress, listServerProfiles, removeServerProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { classifyPairingLink } from '@/auth/pairing/classifyPairingLink';
import { confirmCanonicalHomeUrl, confirmInsecureHomeHttp, homeConnectFailureMessage, resolveHomeConnectLink } from '@/components/homes/add/homeConnectPresentation';
import { openAddHome } from '@/components/homes/add/openAddHome';
import { removeServerProfileUiAction } from '@/components/serverProfiles/removeServerProfileUiAction';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';
import { useEndpointReachabilityRemediationController } from '@/components/settings/server/hooks/useEndpointReachabilityRemediationController';
import { canConnectHomeByAddress, resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { useFirstRunPersonalHome, useRequestPersonalHomeBootstrap } from '@/components/personalHome/bootstrap/personalHomeBootstrapRequest';
import { isLocalishServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import {
    getEndpointReachabilityProvider,
    resolveEndpointReachabilityRemediation,
    type EndpointReachabilityRemediation,
} from '@/components/serverReachability/remediation';
import type { EmailPasswordAuthStepRequest } from '@/components/account/auth/emailPassword/EmailPasswordAuthStep';
import type { OAuthBrowserWait } from '@/components/account/auth/OAuthBrowserWaitStep';
import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { RelayAccessControlOptions } from '@/components/settings/server/relayAccess/useRelayAccessControl';

import { WebDesktopRelayHostHandoffContent } from '@/components/onboarding/steps/webDesktop/WebDesktopRelayHostHandoffContent';
import { resolveWizardCapabilities } from '../capabilities/resolveWizardCapabilities';
import { canSkipWizardStep, getWizardProgress } from '../state/wizardSelectors';
import { createWizardState, wizardReducer } from '../state/wizardReducer';
import type { WizardPlatform, WizardRelaySelection, WizardStepId } from '../state/wizardTypes';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from '../steps/ConfirmSwitchRelayStep';
import { resolveReverseQrTargetProfileId, useLoginLeadsWithLink } from '@/components/onboarding/restore/loginWays';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { useEndpointReadinessMap } from '../hooks/useEndpointReadinessMap';
import {
    setOnboardingWizardAwaitingAuthResumeIntent,
} from '../state/wizardResume';
import { getWizardStepDefinition, wizardStepRegistry } from '../state/wizardStepRegistry';
import {
    resolveWizardAdvance,
    type WizardAdvanceResolution,
} from '../state/wizardAdvance';
import { renderOnboardingWizardStepBody } from './OnboardingWizardSurface.renderWizardStepBody';
import { onboardingWizardSurfaceStylesheet } from './OnboardingWizardSurface.styles';
import { RelayChoiceActions, type RelayChoiceAction } from './RelayChoiceActions';
import { WideStepColumn } from '../unauthShell/stepBack';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import {
    buildDefaultRelaySelection,
    ensureCanonicalCloudRelayProfile,
    isWebMixedContentBlockedEndpoint,
    resolveCanonicalCloudRelayProfile,
    resolveRelaySwitchUrl,
    resolveTrueLocalRelayRuntimeBindUrl,
} from './relaySelection/relaySelectionHelpers';
import { useWizardChromeOverrides } from '../hooks/useWizardChromeOverrides';
import type { WizardChoice, WizardProfileChoice } from './relaySelection/relaySelectionTypes';
import { resolveAddHomePaths } from '@/components/homes/add/addHomeFlowModel';
import { buildRelayProfileChoices } from './relaySelection/buildRelayProfileChoices';
import { Icon } from '@/components/ui/icons/Icon';

export type OnboardingWizardSurfaceProps = Readonly<{
    testID?: string;
    layout: 'portrait' | 'landscape';
    isDesktopShell: boolean;
    shellChrome?: React.ReactNode;
    wizardChromeMode?: 'overlay' | 'embedded' | 'bare';
    wizardLayoutPresentation?: 'auto' | 'card' | 'fullscreen';
    authEntryOptions: AuthEntryOptions;
    isHomeAuthenticated?: boolean;
    /**
     * Advertised sign-in methods of the selected sign-in service. Absent for hosts that do not
     * own an unauthenticated entry (the setup wizard reuses this surface while authenticated).
     */
    accountServiceEntry?: AccountServiceEntryOptions;
    accountContinuationIntent?: AccountContinuationIntent;
    accountEntryReturnTo?: string;
    initialStepId?: WizardStepId;
    initialServerUrl?: string;
    onInitialServerUrlConnected?: () => void;

    /** Provider sign-in on the selected sign-in service. Never touches the focused Home. */
    onContinueWithAccountServiceProvider?: (request: WelcomeAuthenticationMethod, context: WelcomeAuthenticationActionContext) => Promise<void> | void;
    onContinueWithHomeAuthentication?: (request: WelcomeAuthenticationMethod, context: WelcomeAuthenticationActionContext) => Promise<void> | void;
    onAccountDirectoryKeyResult?: (result: AccountDirectoryKeyLoginOutcome) => Promise<void> | void;
    onSelectAccountService?: AccountServiceSelectionFormProps['onSelect'];
}>;

export type WelcomeAuthenticationActionContext = Readonly<{
    signal: AbortSignal;
    emailProvision?: WelcomeAuthenticationMethod;
    /** Opens the shared email/password controller as the next step of this workflow. */
    presentEmailPassword: (request: EmailPasswordAuthStepRequest) => void;
    presentOAuthBrowserWait: (wait: OAuthBrowserWait) => void;
}>;

export type OnboardingWizardController = Readonly<{
    stepId: WizardStepId;
    currentStepIndex: number;
    stepCount: number;
    showBack: boolean;
    showSkip: boolean | undefined;
    navigationLocked: boolean;
    onBack: (() => void) | null;
    onSkip: (() => Promise<void> | void) | null;
    onPrimary: (() => Promise<void> | void) | null;
    primaryLabel: React.ReactNode;
    primaryDisabled: boolean;
    skipLabel: React.ReactNode | null;
    skipDisabled: boolean;
    title: string;
    subtitle: string | null;
    /** The body draws its own heading; hosts render `title` for naming only. */
    bodyOwnsHeading: boolean;
    footerHint: React.ReactNode | null;
    homeContext: OnboardingWizardHomeContext | null;
    body: React.ReactNode;
    goToStep: (stepId: WizardStepId) => void;
}>;

export type OnboardingWizardHomeContext = Readonly<{
    relayUrl: string;
    status: 'active' | 'selected';
}>;

/** Two choice cards side by side wherever two fit (a computer), one per line on a phone. */
const RELAY_CHOICE_MIN_TILE_WIDTH_PX = 220;

/** One "Where should your Home live?" option: its card, how choosing it applies, and its own operations. */
type RelayChoiceItem = SelectionTile<string> & Readonly<{
    selected: boolean;
    onSelect: () => void;
    secondaryAction?: Readonly<{ testID: string; title: string; onPress: () => void }>;
    menuActions?: ReadonlyArray<RelayChoiceAction>;
}>;

export function useOnboardingWizardController(props: OnboardingWizardSurfaceProps): OnboardingWizardController {
    const requestPersonalHomeBootstrap = useRequestPersonalHomeBootstrap();
    const firstRunPersonalHome = useFirstRunPersonalHome();
    const preparedPersonalHome = firstRunPersonalHome?.profile;
    const startPersonalHome = React.useCallback(() => requestPersonalHomeBootstrap?.('first-run'), [requestPersonalHomeBootstrap]);
    const homeRouter = useHomeRouter();
    const { theme } = useUnistyles();
    const styles = onboardingWizardSurfaceStylesheet;
    const activeServerSnapshot = useActiveServerSnapshot();
    const wizardPlatform: WizardPlatform = props.isDesktopShell ? 'desktop' : (Platform.OS === 'web' ? 'web' : 'native');
    const wizardCapabilities = React.useMemo(
        () => resolveWizardCapabilities({ platform: wizardPlatform, isDesktopShell: props.isDesktopShell }),
        [props.isDesktopShell, wizardPlatform],
    );
    const setupPolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
    const canonicalCloudUrl = canonicalCloudProfile?.serverUrl ?? '';
    const snapshotRelayUrl = React.useMemo(() => {
        const serverUrl = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
        if (serverUrl) return serverUrl;
        const localUrl = activeServerSnapshot.activeLocalRelayUrl ? String(activeServerSnapshot.activeLocalRelayUrl).trim() : '';
        return localUrl;
    }, [activeServerSnapshot.activeLocalRelayUrl, activeServerSnapshot.serverUrl]);
    const lastKnownSnapshotRelayUrlRef = React.useRef<string>(snapshotRelayUrl);
    React.useEffect(() => {
        const url = snapshotRelayUrl;
        if (url) {
            lastKnownSnapshotRelayUrlRef.current = url;
        }
    }, [snapshotRelayUrl]);

    const loginLeadsWithLink = useLoginLeadsWithLink();
    const canScanQr = loginLeadsWithLink && canUseCurrentDeviceQrScanner();

    const [urlDraft, setUrlDraft] = React.useState('');
    const [homeAddressError, setHomeAddressError] = React.useState<string | null>(null);
    const changeHomeAddress = React.useCallback((value: string) => {
        setUrlDraft(value);
        setHomeAddressError(null);
    }, []);
    const [relaySwitchDecision, setRelaySwitchDecision] = React.useState<RelaySwitchDecision>('switch');
    const [relayAccessTarget, setRelayAccessTarget] = React.useState<RelayAccessTaskTarget | null>(null);
    const relayAccessRunnerRef = React.useRef<RelayAccessControlOptions['runWithTarget']>(undefined);
    const relayAccessRemoteHostRef = React.useRef<RelayAccessControlOptions['remoteHost']>(undefined);
    const [relayAccessShareUrl, setRelayAccessShareUrl] = React.useState<string | null>(null);
    const [accountDirectoryKeyRequest, setAccountDirectoryKeyRequest] = React.useState<WelcomeAuthenticationMethod | null>(null);
    const [emailPasswordRequest, setEmailPasswordRequest] = React.useState<EmailPasswordAuthStepRequest | null>(null);
    const [oauthBrowserWait, setOAuthBrowserWait] = React.useState<OAuthBrowserWait | null>(null);
    const [accountDirectoryContinuationIntent, setAccountDirectoryContinuationIntent] = React.useState<AccountContinuationIntent | null>(null);
    const [accountDirectoryHomeRecovery, setAccountDirectoryHomeRecovery] = React.useState<Readonly<{
        kind: 'home_auth' | 'continuation';
        input: AccountPostAuthInput;
        previous: AccountPostAuthResult;
        homeServerIdentityId: string;
    }> | null>(null);
    const defaultRelayAccessTarget = React.useMemo<RelayAccessTaskTarget>(() => ({ kind: 'local' }), []);
    const [state, setState] = React.useState(() => {
        const context = {
            mode: 'onboarding',
            platform: props.isDesktopShell ? 'desktop' : (Platform.OS === 'web' ? 'web' : 'native'),
            canRunSystemTasks: props.isDesktopShell,
            relaySelection: buildDefaultRelaySelection(),
            relayAccessProviderId: null,
            relaySwitchConfirmationPending: false,
            authIntent: 'standard',
        } as const;

        const requestedStepId = props.initialStepId ?? 'welcome';
        const requestedStep = getWizardStepDefinition(requestedStepId);
        const isRequestedOpenable = requestedStep.directEntry === true || requestedStep.visibleWhen(context);
        const initialStepId = isRequestedOpenable ? requestedStepId : 'welcome';

        return createWizardState({
            context: {
                ...context,
            },
            currentStepId: initialStepId,
            history: [],
            resumeState: null,
        });
    });
    const currentState = React.useRef(state);
    const dispatch = React.useCallback((action: WizardAction, kind?: 'back' | 'notice') => {
        const previous = currentState.current;
        const next = wizardReducer(previous, action);
        if (next === previous) return;
        const commit = () => {
            currentState.current = next;
            setState(next);
        };
        if (next.currentStepId === previous.currentStepId) {
            commit();
            return;
        }
        runStepMove({
            layer: 'workflow',
            kind: kind ?? (action.type === 'wizard/back' ? 'back' : 'step'),
            fromWelcome: previous.currentStepId === 'welcome',
            toWelcome: next.currentStepId === 'welcome',
            commit,
        });
    }, []);
    const canCreatePersonalHome = requestPersonalHomeBootstrap != null;
    React.useEffect(() => {
        if (!preparedPersonalHome) return;
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: {
                choiceId: 'thisComputer',
                serverUrl: preparedPersonalHome.serverUrl,
                relayProfileId: preparedPersonalHome.id,
                locked: false,
            },
        });
        dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
    }, [dispatch, preparedPersonalHome]);


    const handleSelectAccountService = React.useCallback<AccountServiceSelectionFormProps['onSelect']>(async (url, options) => {
        const result = await props.onSelectAccountService?.(url, options) ?? { kind: 'unavailable' as const };
        if (result.kind === 'selected') {
            dispatch({ type: 'wizard/goToStep', stepId: 'welcome' });
        }
        return result;
    }, [props.onSelectAccountService]);

    const connectAndFocusHomeAddress = React.useCallback(async (
        serverUrl: string,
        onFailure?: (message: string) => void,
    ): Promise<ServerProfile | null> => {
        const showFailure = onFailure ?? ((message: string) => Modal.alert(t('common.error'), message));
        const saved = listServerProfiles().find((profile) => (
            isSameServerUrl(profile.serverUrl, serverUrl)
            || (profile.canonicalServerUrl != null && isSameServerUrl(profile.canonicalServerUrl, serverUrl))
        ));
        if (saved) {
            const switched = await setActiveServerAndSwitch({ serverId: saved.id, scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()) });
            if (switched === 'blocked') return null;
            props.onInitialServerUrlConnected?.();
            return saved;
        }

        try {
            const result = await connectHomeAtAddress({
                serverUrl,
                source: 'url',
                confirmInsecureHttp: confirmInsecureHomeHttp,
                confirmCanonicalUrl: confirmCanonicalHomeUrl,
            });
            if (result.kind === 'connected') {
                const switched = await setActiveServerAndSwitch({ serverId: result.profile.id, scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()) });
                if (switched === 'blocked') return null;
                props.onInitialServerUrlConnected?.();
                return result.profile;
            }
            const failureMessage = homeConnectFailureMessage(result);
            if (failureMessage) showFailure(failureMessage);
            return null;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return null;
            showFailure(t('errors.operationFailed'));
            return null;
        }
    }, [props.onInitialServerUrlConnected]);

    const applyWizardAdvanceResolution = React.useCallback(async (
        resolution: WizardAdvanceResolution,
        onAddressFailure?: (message: string) => void,
    ): Promise<boolean> => {
        let connectedProfile: ServerProfile | null = null;
        for (const effect of resolution.effects) {
            switch (effect.type) {
                case 'activateServerUrl':
                    connectedProfile = await connectAndFocusHomeAddress(effect.serverUrl, onAddressFailure);
                    if (!connectedProfile) return false;
                    break;
                case 'activateServerProfile':
                    if (await setActiveServerAndSwitch({
                        serverId: effect.serverId,
                        scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                    }) === 'blocked') return false;
                    break;
                case 'setRelaySelection':
                    dispatch({
                        type: 'wizard/setRelaySelection',
                        relaySelection: connectedProfile
                            ? {
                                ...effect.relaySelection,
                                serverUrl: connectedProfile.serverUrl,
                                relayProfileId: effect.relaySelection.choiceId === 'customUrl' ? connectedProfile.id : effect.relaySelection.relayProfileId,
                            }
                            : effect.relaySelection,
                    });
                    break;
                case 'persistOnboardingIntent':
                    setOnboardingWizardAwaitingAuthResumeIntent(connectedProfile?.serverUrl ?? effect.relayUrl);
                    break;
                case 'clearRelayAccessDraft':
                    relayAccessRunnerRef.current = undefined;
                    relayAccessRemoteHostRef.current = undefined;
                    setRelayAccessTarget(null);
                    setRelayAccessShareUrl(null);
                    break;
            }
        }

        if (resolution.nextStepId) {
            dispatch({ type: 'wizard/goToStep', stepId: resolution.nextStepId });
        }
        return true;
    }, [connectAndFocusHomeAddress, dispatch, state.context.mode]);

    const stepId = state.currentStepId;
    const welcomeAuthenticationRef = React.useRef<{ controller: AbortController; stepId: WizardStepId } | null>(null);
    React.useEffect(() => {
        if (stepId !== 'auth_oauth_browser_wait') setOAuthBrowserWait(null);
        const current = welcomeAuthenticationRef.current;
        if (current && current.stepId !== stepId) {
            current.controller.abort();
            welcomeAuthenticationRef.current = null;
        }
    }, [stepId]);
    React.useEffect(() => () => {
        welcomeAuthenticationRef.current?.controller.abort();
        welcomeAuthenticationRef.current = null;
    }, []);
    const runWelcomeAuthenticationAction = React.useCallback(async (
        request: WelcomeAuthenticationMethod,
        action: ((request: WelcomeAuthenticationMethod, context: WelcomeAuthenticationActionContext) => Promise<void> | void) | undefined,
        emailProvision?: WelcomeAuthenticationMethod,
    ) => {
        if (!action || welcomeAuthenticationRef.current) return;
        const controller = new AbortController();
        const active = { controller, stepId };
        welcomeAuthenticationRef.current = active;
        try {
            await action(request, {
                signal: controller.signal,
                ...(emailProvision ? { emailProvision } : {}),
                presentOAuthBrowserWait: (wait) => {
                    if (welcomeAuthenticationRef.current !== active || controller.signal.aborted) return;
                    active.stepId = 'auth_oauth_browser_wait';
                    setOAuthBrowserWait(wait);
                    dispatch({ type: 'wizard/goToStep', stepId: 'auth_oauth_browser_wait' });
                },
                presentEmailPassword: (emailPassword) => {
                    if (welcomeAuthenticationRef.current !== active || controller.signal.aborted) return;
                    setEmailPasswordRequest(emailPassword);
                    if (active.stepId !== 'auth_email_password') {
                        active.stepId = 'auth_email_password';
                        dispatch({ type: 'wizard/goToStep', stepId: 'auth_email_password' });
                    }
                },
            });
        } finally {
            if (welcomeAuthenticationRef.current === active && active.stepId !== 'auth_email_password') {
                welcomeAuthenticationRef.current = null;
            }
        }
    }, [stepId]);
    const [restoreNavigationLocked, setRestoreNavigationLocked] = React.useState(false);
    React.useEffect(() => {
        if (stepId !== 'auth_restore') setRestoreNavigationLocked(false);
    }, [stepId]);
    const {
        activePrimaryOverride,
        activeBackOverride,
        activeSkipOverride,
        setWizardPrimaryOverride: handleWizardPrimaryChange,
        setWizardBackOverride: handleWizardBackChange,
        setWizardSkipOverride: handleWizardSkipChange,
    } = useWizardChromeOverrides(stepId);

    React.useEffect(() => {
        if (stepId !== 'relay_enter_url') {
            return;
        }
        if (urlDraft.trim().length > 0) {
            return;
        }
        const selectedRelayUrl = typeof state.context.relaySelection.serverUrl === 'string'
            ? state.context.relaySelection.serverUrl.trim()
            : '';
        if (!selectedRelayUrl) return;
        setUrlDraft(selectedRelayUrl);
    }, [
        state.context.relaySelection.serverUrl,
        stepId,
        urlDraft,
    ]);
    const progress = getWizardProgress(state.context, stepId);
    const currentStepIndex = Math.max(0, progress.current - 1);
    const welcomeHasExplicitRelaySelection = stepId === 'welcome'
        && (
            state.history.length > 0
            || Boolean(readConfiguredServerUrlEnv())
            || state.context.relaySelection.choiceId !== 'cloud'
            || state.context.relaySelection.relayProfileId != null
        );
    const welcomeRelayUrl = React.useMemo(() => {
        if (!welcomeHasExplicitRelaySelection) {
            return '';
        }
        const selectedRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        if (selectedRelayUrl) {
            return selectedRelayUrl;
        }

        const activeRelayUrl = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
        if (activeRelayUrl) {
            return activeRelayUrl;
        }

        const configuredRelayUrl = String(readConfiguredServerUrlEnv() ?? '').trim();
        if (configuredRelayUrl) {
            return configuredRelayUrl;
        }

        return '';
    }, [
        activeServerSnapshot.serverUrl,
        state.context.relaySelection.relayProfileId,
        state.context.relaySelection.choiceId,
        state.context.relaySelection.serverUrl,
        state.history.length,
        welcomeHasExplicitRelaySelection,
    ]);
    const welcomeHasKnownRelay = stepId === 'welcome' && Boolean(welcomeRelayUrl);
    const welcomeHasAuthActions = welcomeHasKnownRelay && (
        props.authEntryOptions.serverAvailability === 'ready'
        || props.authEntryOptions.serverAvailability === 'legacy'
    );

    // Note: capability is captured at init time; if device size changes, we tolerate it until reload.

    const addHomePaths = React.useMemo(() => resolveAddHomePaths({
        entry: 'signed_out',
        cloudAvailable: setupPolicy.relay.allowHappierCloud,
        localAvailable: props.isDesktopShell ? canCreatePersonalHome : setupPolicy.relay.allowLocalRelayHost,
        sshAvailable: wizardCapabilities.allowRemoteSshRelayChoice,
        directAvailable: canConnectHomeByAddress(setupPolicy),
    }), [canCreatePersonalHome, props.isDesktopShell, setupPolicy, wizardCapabilities.allowRemoteSshRelayChoice]);

    const serverProfilesGeneration = useServerProfilesGeneration();
    const profileChoices = React.useMemo((): WizardProfileChoice[] => {
        return [...buildRelayProfileChoices({
            relaySelectionServerUrl: state.context.relaySelection.serverUrl,
            relaySelectionChoiceId: state.context.relaySelection.choiceId ?? '',
            activeServerUrl: activeServerSnapshot.serverUrl,
        })];
    }, [activeServerSnapshot.serverUrl, serverProfilesGeneration, state.context.relaySelection.choiceId, state.context.relaySelection.serverUrl]);

    const selectedSavedRelayProfile = React.useMemo(() => {
        const relayProfileId = state.context.relaySelection.relayProfileId;
        if (!relayProfileId) return null;
        return profileChoices.find((profile) => profile.id === relayProfileId) ?? null;
    }, [profileChoices, state.context.relaySelection.relayProfileId]);

    const canonicalCloudReadinessEndpoint = React.useMemo(() => {
        if (!canonicalCloudUrl) return null;
        return normalizeServerUrl(canonicalCloudUrl) ?? canonicalCloudUrl;
    }, [canonicalCloudUrl]);

    const activeServerSnapshotForLocalBind = getActiveServerSnapshot();
    const trueLocalRelayRuntimeBindUrl = React.useMemo(() => {
        return resolveTrueLocalRelayRuntimeBindUrl({
            activeServerUrl: activeServerSnapshotForLocalBind.serverUrl ?? null,
            activeLocalRelayUrl: activeServerSnapshotForLocalBind.activeLocalRelayUrl ?? null,
        });
    }, [activeServerSnapshotForLocalBind.activeLocalRelayUrl, activeServerSnapshotForLocalBind.serverUrl]);

    const enteredHomeLink = React.useMemo(() => classifyPairingLink(urlDraft), [urlDraft]);
    const relayEnterUrlEndpointForReadiness = React.useMemo(() => {
        if (stepId !== 'relay_enter_url' || enteredHomeLink.kind !== 'unknown') {
            return null;
        }
        const trimmed = urlDraft.trim();
        return trimmed ? normalizeServerUrl(trimmed) : null;
    }, [enteredHomeLink.kind, stepId, urlDraft]);

    const confirmSwitchRelayEndpointForReadiness = React.useMemo(() => {
        if (stepId !== 'confirm_switch_relay' || relaySwitchDecision !== 'switch') {
            return null;
        }
        const relayUrl = resolveRelaySwitchUrl({
            relayRuntimeUrl: state.context.relaySelection.serverUrl,
            relayAccessShareUrl,
            relayAccessTarget,
        }) ?? '';
        return relayUrl ? normalizeServerUrl(relayUrl) : null;
    }, [relayAccessShareUrl, relayAccessTarget, relaySwitchDecision, state.context.relaySelection.serverUrl, stepId]);

    const { readinessByEndpoint: relayReadinessByEndpoint, retryEndpoint } = useEndpointReadinessMap({
        endpoints: [
            ...(stepId === 'relay_select'
                ? [
                    ...profileChoices.map((profile) => profile.serverUrl),
                    ...(canonicalCloudReadinessEndpoint ? [canonicalCloudReadinessEndpoint] : []),
                    ...(trueLocalRelayRuntimeBindUrl ? [trueLocalRelayRuntimeBindUrl] : []),
                ]
                : []),
            ...(relayEnterUrlEndpointForReadiness ? [relayEnterUrlEndpointForReadiness] : []),
            ...(confirmSwitchRelayEndpointForReadiness ? [confirmSwitchRelayEndpointForReadiness] : []),
        ],
        enabled: stepId === 'relay_select' || stepId === 'relay_enter_url' || stepId === 'confirm_switch_relay',
    });

    const handleRemoveRelayProfile = React.useCallback(async (profileId: string) => {
        const id = String(profileId ?? '').trim();
        if (!id || id === 'active') {
            return;
        }

        const serverUrl = profileChoices.find((profile) => profile.id === id)?.serverUrl ?? '';
        try {
            await presentFirstKeyCredentialLifecycle({
                run: async () =>
                    await removeServerProfileUiAction({
                        profileId: id,
                        serverUrl,
                    }),
                onCompleted: () => {
                    if (state.context.relaySelection.relayProfileId !== id) {
                        return;
                    }
                    relayAccessRunnerRef.current = undefined;
                    relayAccessRemoteHostRef.current = undefined;
                    setRelayAccessTarget(null);
                    setRelayAccessShareUrl(null);
                    dispatch({
                        type: 'wizard/setRelaySelection',
                        relaySelection: {
                            choiceId: null,
                            serverUrl: null,
                            relayProfileId: null,
                            locked: state.context.relaySelection.locked,
                        },
                    });
                },
            });
        } catch {
            // ignore: profile may have been removed elsewhere
        }
    }, [profileChoices, state.context.relaySelection.locked, state.context.relaySelection.relayProfileId]);

    const selectRelayChoice = React.useCallback((choiceId: WizardChoice['id']) => {
        const next: WizardRelaySelection = {
            choiceId,
            serverUrl: choiceId === 'cloud' ? (canonicalCloudUrl || null) : null,
            relayProfileId: null,
            locked: choiceId === 'customUrl' ? state.context.relaySelection.locked : false,
        };
        relayAccessRunnerRef.current = undefined;
        relayAccessRemoteHostRef.current = undefined;
        setRelayAccessTarget(null);
        setRelayAccessShareUrl(null);
        dispatch({ type: 'wizard/setRelaySelection', relaySelection: next });
    }, [canonicalCloudUrl, state.context.relaySelection]);

    const selectProfileRelay = React.useCallback((profile: WizardProfileChoice) => {
        relayAccessRunnerRef.current = undefined;
        relayAccessRemoteHostRef.current = undefined;
        setRelayAccessTarget(null);
        setRelayAccessShareUrl(null);
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: {
                choiceId: 'customUrl',
                serverUrl: profile.serverUrl,
                relayProfileId: profile.id,
                locked: state.context.relaySelection.locked,
            },
        });
    }, [state.context.relaySelection.locked]);

    const buildRelayChoiceItem = (choice: WizardChoice | WizardProfileChoice): RelayChoiceItem => {
        if ((choice as WizardProfileChoice).kind === 'profile') {
            const profile = choice as WizardProfileChoice;
            const selected = state.context.relaySelection.choiceId === 'customUrl'
                && state.context.relaySelection.relayProfileId === profile.id;
            const readiness = relayReadinessByEndpoint.get(profile.serverUrl);
            const blocked = readiness?.status === 'blocked' || isWebMixedContentBlockedEndpoint(profile.serverUrl);
            const unavailable = readiness?.status === 'unavailable';
            const disabled = Boolean(profile.disabled)
                || state.context.relaySelection.locked
                ;
            return {
                id: `profile:${profile.id}`,
                testID: `${props.testID ?? 'onboarding-wizard'}-relay:profile:${profile.id}`,
                selected,
                disabled,
                onSelect: () => selectProfileRelay(profile),
                icon: 'link',
                title: profile.name,
                subtitle: toServerUrlDisplay(profile.serverUrl),
                // An address has no word to wrap at: one line that gives up its middle (owner 2026-11-20).
                subtitleTruncation: 'middle',
                status: blocked ? t('common.blocked') : unavailable ? t('common.unreachable') : undefined,
                menuActions: [
                    ...((unavailable || blocked) ? [{
                        id: 'retry',
                        title: t('common.retry'),
                        onPress: () => retryEndpoint(profile.serverUrl),
                    }] : []),
                    ...(profile.id !== 'active' ? [{
                        id: 'remove',
                        title: t('common.remove'),
                        destructive: true,
                        onPress: () => { void handleRemoveRelayProfile(profile.id); },
                    }] : []),
                ],
            };
        }

        const fixed = choice as WizardChoice;
        const selected = state.context.relaySelection.choiceId === fixed.id;
        const cloudReadinessEndpoint = fixed.id === 'cloud' ? canonicalCloudReadinessEndpoint : null;
        const cloudBlocked =
            fixed.id === 'cloud'
                && Boolean(cloudReadinessEndpoint)
                && relayReadinessByEndpoint.get(cloudReadinessEndpoint!)?.status === 'blocked';
        const cloudUnavailable =
            fixed.id === 'cloud'
                && Boolean(cloudReadinessEndpoint)
                && relayReadinessByEndpoint.get(cloudReadinessEndpoint!)?.status === 'unavailable';
        const disabled = Boolean(fixed.disabled)
            || state.context.relaySelection.locked
            || (fixed.id === 'cloud' && (cloudUnavailable || cloudBlocked) && !selected);
        return {
            id: fixed.id,
            testID: `${props.testID ?? 'onboarding-wizard'}-relay:${fixed.id}`,
            selected,
            disabled,
            onSelect: () => {
                selectRelayChoice(fixed.id);
            },
            icon: fixed.icon,
            title: fixed.title,
            subtitle: fixed.subtitle,
            status: cloudBlocked ? t('common.blocked') : cloudUnavailable ? t('common.unreachable') : undefined,
            secondaryAction: (cloudUnavailable || cloudBlocked) ? {
                testID: `${props.testID ?? 'onboarding-wizard'}-relay:${fixed.id}-retry`,
                title: t('common.retry'),
                onPress: () => retryEndpoint(cloudReadinessEndpoint!),
            } : undefined,
        };
    };

    const buildManualRelayChoiceItem = (): RelayChoiceItem | null => {
        const rawServerUrl = state.context.relaySelection.serverUrl
            ? String(state.context.relaySelection.serverUrl).trim()
            : '';
        const selected = state.context.relaySelection.choiceId === 'customUrl'
            && !state.context.relaySelection.relayProfileId
            && !selectedSavedRelayProfile;

        return {
            id: 'customUrl',
            testID: `${props.testID ?? 'onboarding-wizard'}-relay:customUrl`,
            selected,
            disabled: state.context.relaySelection.locked && !selected,
            onSelect: () => {
                relayAccessRunnerRef.current = undefined;
                relayAccessRemoteHostRef.current = undefined;
                setRelayAccessTarget(null);
                setRelayAccessShareUrl(null);
                dispatch({
                    type: 'wizard/setRelaySelection',
                    relaySelection: {
                        choiceId: 'customUrl',
                        serverUrl: rawServerUrl || null,
                        relayProfileId: null,
                        locked: state.context.relaySelection.locked,
                    },
                });
            },
            icon: 'link',
            title: t('setupOnboarding.relayCustomUrlTitle'),
            subtitle: t('setupOnboarding.relayCustomUrlSubtitle'),
        };
    };

    const resolveStateForAdvance = React.useCallback(() => {
        const selection = state.context.relaySelection;
        if (stepId !== 'relay_select' || selection.choiceId !== 'customUrl' || !selection.relayProfileId) {
            return state;
        }

        // The default active selection deliberately keeps `serverUrl` dynamic so an
        // external relay change is reflected until the user commits. Materialize the
        // currently selected profile URL at that commit boundary; otherwise a valid
        // preselected profile is mistaken for manual URL entry and S1 immediately
        // synchronizes the resulting relay-enter step back to relay selection.
        const selectedServerUrlRaw = selection.serverUrl
            ? String(selection.serverUrl).trim()
            : String(selectedSavedRelayProfile?.serverUrl ?? '').trim();
        const resolved = selectedServerUrlRaw ? normalizeServerUrl(selectedServerUrlRaw) : null;
        return {
            ...state,
            context: {
                ...state.context,
                relaySelection: {
                    ...selection,
                    serverUrl: resolved,
                },
            },
        };
    }, [selectedSavedRelayProfile?.serverUrl, state, stepId]);

    const handleAdvance = React.useCallback(async () => {
        const stateForAdvance = resolveStateForAdvance();
        const selection = stateForAdvance.context.relaySelection;
        const selectedServerUrl = selection.serverUrl ? String(selection.serverUrl).trim() : '';
        const ensuredCloudProfile = stepId === 'relay_select' && selection.choiceId === 'cloud'
            ? await ensureCanonicalCloudRelayProfile()
            : null;
        const cloudRelay = ensuredCloudProfile
            ?? (canonicalCloudProfile?.serverId
                ? { serverId: canonicalCloudProfile.serverId, serverUrl: canonicalCloudProfile.serverUrl }
                : null);
        const activeSnapshot = getActiveServerSnapshot();
        const activeServerMatchesSelectedRelay = selectedServerUrl
            ? isSameServerUrl(activeSnapshot.serverUrl, selectedServerUrl)
            : cloudRelay
                ? isSameServerUrl(activeSnapshot.serverUrl, cloudRelay.serverUrl)
                : undefined;

        return await applyWizardAdvanceResolution(resolveWizardAdvance(
            stateForAdvance,
            wizardStepRegistry,
            {
                type: 'primary',
                isDesktopShell: props.isDesktopShell,
                activeServerMatchesSelectedRelay,
                cloudRelay,
            },
        ));
    }, [
        applyWizardAdvanceResolution,
        canonicalCloudProfile?.serverId,
        canonicalCloudProfile?.serverUrl,
        props.isDesktopShell,
        resolveStateForAdvance,
        stepId,
    ]);

    const handleRemoteRelayRuntimeCompletedChange = React.useCallback((payload: Readonly<{
        machineId: string | null;
        relayRuntimeUrl: string | null;
        relayAccessTarget: RelayAccessTaskTarget | null;
        runWithRelayAccessTarget?: RelayAccessControlOptions['runWithTarget'];
        relayAccessRemoteHost?: RelayAccessControlOptions['remoteHost'];
        mode: 'remoteMachine' | 'remoteRelayHost';
    }>) => {
        const relayUrl = payload.relayRuntimeUrl;
        if (!relayUrl) {
            return;
        }

        setRelaySwitchDecision('switch');
        relayAccessRunnerRef.current = payload.runWithRelayAccessTarget;
        relayAccessRemoteHostRef.current = payload.relayAccessRemoteHost;
        setRelayAccessTarget(payload.relayAccessTarget);
        setRelayAccessShareUrl(null);
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: {
                choiceId: 'remoteComputer',
                serverUrl: relayUrl,
                relayProfileId: null,
                locked: false,
            },
        });
    }, [dispatch]);

    const handleRelayAccessShareUrlChange = React.useCallback((shareUrl: string | null) => {
        const normalized = typeof shareUrl === 'string' ? shareUrl.trim() : '';
        setRelayAccessShareUrl(normalized || null);
    }, []);

    const handleBack = React.useCallback(() => {
        if (stepId === 'auth_oauth_browser_wait' && oauthBrowserWait) {
            void oauthBrowserWait.cancel();
        }
        dispatch({ type: 'wizard/back' });
    }, [dispatch, oauthBrowserWait, stepId]);

    const handleBackToWelcome = React.useCallback(() => {
        dispatch({ type: 'wizard/goToStep', stepId: 'welcome' }, 'back');
    }, []);

    const handleOpenConnectHome = React.useCallback(() => {
        dispatch({ type: 'wizard/goToStep', stepId: 'connect_home' });
    }, []);

    const handleOpenRelaySelectionFromWelcome = React.useCallback(() => {
        openAddHome(homeRouter, { onWelcomeHomeStep: () => {
            if (!setupPolicy.relay.allowRelaySelection) {
                return;
            }
            if (!state.context.relaySelection.locked) {
                dispatch({ type: 'wizard/setRelaySelection', relaySelection: buildDefaultRelaySelection({ preselectCurrentHome: false }) });
            }
            dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
        } });
    }, [homeRouter, setupPolicy.relay.allowRelaySelection, state.context.relaySelection.locked]);

    const handleOpenRelaySelectionPreservingSelection = React.useCallback(() => {
        if (!setupPolicy.relay.allowRelaySelection) {
            return;
        }
        dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
    }, [setupPolicy.relay.allowRelaySelection]);

    const handleSaveCustomRelayUrl = React.useCallback(async () => {
        const trimmed = urlDraft.trim();
        setHomeAddressError(null);
        const destination = resolveHomeConnectLink(enteredHomeLink);
        if (destination) {
            await runGuardedNavigation(() => homeRouter.push(destination as never));
            return;
        }
        if (destination === null) {
            setHomeAddressError(t('homesJourneys.notAHomeLink'));
            return;
        }
        await applyWizardAdvanceResolution(resolveWizardAdvance(
            state,
            wizardStepRegistry,
            {
                type: 'saveCustomRelayUrl',
                relayUrl: trimmed,
            },
        ), setHomeAddressError);
    }, [applyWizardAdvanceResolution, enteredHomeLink, homeRouter, state, urlDraft]);

    const showBack = stepId !== 'welcome';
    const showSkip = stepId !== 'relay_select'
        && canSkipWizardStep(state.context, stepId)
        && !(
            stepId === 'welcome'
            && welcomeHasKnownRelay
            && (
                props.authEntryOptions.serverAvailability === 'loading'
                || props.authEntryOptions.serverAvailability === 'unavailable'
                || props.authEntryOptions.serverAvailability === 'incompatible'
            )
        );

    const stepDefinition = getWizardStepDefinition(stepId);
    const handoffHomeUrl = state.context.relaySelection.serverUrl;
    const title = stepId === 'background_service_handoff' && handoffHomeUrl
        ? t('setupOnboarding.connectComputerStep.title', { home: defaultHomeNameForAddress(handoffHomeUrl) })
        : t(stepDefinition.titleKey);
    const subtitle = stepDefinition.subtitleKey ? t(stepDefinition.subtitleKey) : null;

    const primaryLabel =
        stepId === 'welcome'
            ? t('setupOnboarding.letsStart')
            : stepId === 'desktop_handoff'
                ? t('setupOnboarding.webDesktopOnlyPrimary')
                : stepId === 'relay_enter_url'
                    ? t('homesJourneys.connect')
                    : t('common.continue');

    const selectedRelayFooterUrl = React.useMemo(() => {
        if (stepId !== 'relay_select') return null;
        if (state.context.relaySelection.choiceId === 'cloud') {
            return canonicalCloudUrl || null;
        }
        if (
            state.context.relaySelection.choiceId === 'customUrl'
            && state.context.relaySelection.relayProfileId === 'active'
        ) {
            return snapshotRelayUrl || null;
        }
        const rawRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        if (rawRelayUrl) {
            return rawRelayUrl;
        }
        return selectedSavedRelayProfile?.serverUrl ?? null;
    }, [
        canonicalCloudUrl,
        selectedSavedRelayProfile?.serverUrl,
        snapshotRelayUrl,
        state.context.relaySelection.choiceId,
        state.context.relaySelection.relayProfileId,
        state.context.relaySelection.serverUrl,
        stepId,
    ]);

    // The Home a step acts on (or, while choosing, the one selected). Hosts present it their own
    // way: a footer summary in the card, one quiet line in the welcome pane's header.
    const homeContext = React.useMemo((): OnboardingWizardHomeContext | null => {
        // These steps present their own Home or sign-in service context.
        if (stepId === 'auth_email_password' || stepId === 'auth_oauth_browser_wait' || stepId === 'connect_home') return null;
        if (stepId === 'relay_select') {
            const resolvedRelayUrl = selectedRelayFooterUrl || lastKnownSnapshotRelayUrlRef.current;
            if (!resolvedRelayUrl) return null;
            const status = snapshotRelayUrl && isSameServerUrl(snapshotRelayUrl, resolvedRelayUrl)
                ? 'active'
                : 'selected';
            return { relayUrl: resolvedRelayUrl, status };
        }
        if (stepId === 'welcome' && !welcomeHasKnownRelay) return null;
        const rawRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        const fallbackRelayUrl = welcomeRelayUrl || lastKnownSnapshotRelayUrlRef.current;
        const resolvedRelayUrl = stepId === 'welcome'
            ? (welcomeRelayUrl || rawRelayUrl || lastKnownSnapshotRelayUrlRef.current)
            : (rawRelayUrl || fallbackRelayUrl);
        if (!resolvedRelayUrl) return null;
        return { relayUrl: resolvedRelayUrl, status: 'active' };
    }, [
        selectedRelayFooterUrl,
        snapshotRelayUrl,
        state.context.relaySelection.choiceId,
        state.context.relaySelection.serverUrl,
        stepId,
        welcomeHasKnownRelay,
        welcomeRelayUrl,
    ]);
    const footerHint = React.useMemo(() => (
        homeContext ? (
            <ActiveRelaySummary
                idPrefix={`${props.testID ?? 'onboarding-wizard'}-relay-hint`}
                relayUrl={homeContext.relayUrl}
                status={homeContext.status}
            />
        ) : null
    ), [homeContext, props.testID]);

    const selectedRelayEndpointForReadiness = React.useMemo(() => {
        if (stepId !== 'relay_select') return null;
        if (state.context.relaySelection.choiceId === 'cloud') {
            const normalizedCloud = canonicalCloudUrl ? normalizeServerUrl(canonicalCloudUrl) : null;
            return normalizedCloud ?? null;
        }
        if (state.context.relaySelection.choiceId === 'customUrl' && !state.context.relaySelection.relayProfileId) {
            // Manual entry mode ("Existing relay"): Continue should always open the URL entry step.
            // Reachability gating applies only to concrete selections (saved profiles / cloud).
            return null;
        }
        if (
            state.context.relaySelection.choiceId === 'thisComputer'
            || state.context.relaySelection.choiceId === 'remoteComputer'
        ) {
            return null;
        }
        const raw = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        const selectedByProfile =
            !raw && state.context.relaySelection.choiceId === 'customUrl'
                ? (state.context.relaySelection.relayProfileId === 'active'
                    ? snapshotRelayUrl
                    : profileChoices.find((profile) => profile.id === state.context.relaySelection.relayProfileId)?.serverUrl)
                : null;
        const normalized = raw
            ? normalizeServerUrl(raw)
            : selectedByProfile
                ? normalizeServerUrl(selectedByProfile)
                : null;
        return normalized ?? null;
    }, [
        canonicalCloudUrl,
        profileChoices,
        snapshotRelayUrl,
        state.context.relaySelection.choiceId,
        state.context.relaySelection.relayProfileId,
        state.context.relaySelection.serverUrl,
        stepId,
    ]);

    const activeReachabilityRemediationEndpoint = React.useMemo(() => {
        if (stepId === 'relay_enter_url') {
            return relayEnterUrlEndpointForReadiness;
        }
        if (stepId === 'confirm_switch_relay' && relaySwitchDecision === 'switch') {
            return confirmSwitchRelayEndpointForReadiness;
        }
        return null;
    }, [confirmSwitchRelayEndpointForReadiness, relayEnterUrlEndpointForReadiness, relaySwitchDecision, stepId]);

    const activeReachabilityRemediation = React.useMemo<EndpointReachabilityRemediation | null>(() => {
        if (!activeReachabilityRemediationEndpoint) {
            return null;
        }
        const readiness = relayReadinessByEndpoint.get(activeReachabilityRemediationEndpoint);
        if (!readiness?.probeResult) {
            return null;
        }
        if (readiness.probeResult.status === 'ready') {
            return null;
        }
        return resolveEndpointReachabilityRemediation({
            endpointUrl: activeReachabilityRemediationEndpoint,
            readiness: readiness.probeResult,
            platformOs: Platform.OS,
            isDesktopShell: props.isDesktopShell,
        });
    }, [activeReachabilityRemediationEndpoint, props.isDesktopShell, relayReadinessByEndpoint]);

    const isActiveReachabilityRemediationPending = React.useMemo(() => {
        if (!activeReachabilityRemediationEndpoint) {
            return false;
        }
        if (getEndpointReachabilityProvider(activeReachabilityRemediationEndpoint) !== 'tailscale') {
            return false;
        }
        const readiness = relayReadinessByEndpoint.get(activeReachabilityRemediationEndpoint);
        return readiness == null || readiness.status === 'checking';
    }, [activeReachabilityRemediationEndpoint, relayReadinessByEndpoint]);
    const {
        error: reachabilityRemediationError,
        taskSnapshot: tailscaleEnsureReadySnapshot,
        onAction: handleReachabilityRemediationAction,
    } = useEndpointReachabilityRemediationController({
        remediation: activeReachabilityRemediation,
        endpoint: activeReachabilityRemediationEndpoint,
        onRetryEndpoint: retryEndpoint,
    });

    // A selection naming a Home with no card here (the Home already in use) is not a choice on Where.
    const relaySelectionHasNoCard = state.context.relaySelection.choiceId === 'customUrl'
        && state.context.relaySelection.relayProfileId != null
        && !profileChoices.some((profile) => profile.id === state.context.relaySelection.relayProfileId);
    const primaryDisabled =
        (stepId === 'relay_select' && (
            state.context.relaySelection.choiceId == null
            || relaySelectionHasNoCard
            || (
                selectedRelayEndpointForReadiness != null
                && (
                    relayReadinessByEndpoint.get(selectedRelayEndpointForReadiness)?.status === 'unavailable'
                    || relayReadinessByEndpoint.get(selectedRelayEndpointForReadiness)?.status === 'blocked'
                    || isWebMixedContentBlockedEndpoint(selectedRelayEndpointForReadiness)
                )
            )
        ))
        || (
            stepId === 'relay_enter_url'
            && (
                activeReachabilityRemediation != null
                || isActiveReachabilityRemediationPending
            )
        )
        || (
            stepId === 'confirm_switch_relay'
            && relaySwitchDecision === 'switch'
            && (
                activeReachabilityRemediation != null
                || isActiveReachabilityRemediationPending
                || (tailscaleEnsureReadySnapshot != null && tailscaleEnsureReadySnapshot.result == null)
            )
        )
        || (stepId === 'host_relay_remote' && !normalizeServerUrl(String(state.context.relaySelection.serverUrl ?? '').trim()));

    const handleWelcomeAdvance = React.useCallback(() => {
        const selection = state.context.relaySelection;
        const relayUrl = selection.serverUrl ? String(selection.serverUrl).trim() : '';
        if (selection.choiceId === 'customUrl' && relayUrl.length > 0) {
            setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
            dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
            return;
        }
        dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
    }, [state.context.authIntent, state.context.relaySelection]);

    const ensureActiveServerForAuth = React.useCallback(async (): Promise<boolean> => {
        const rawRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        const fallbackRelayUrl = welcomeRelayUrl ? String(welcomeRelayUrl).trim() : '';
        const candidate = rawRelayUrl || fallbackRelayUrl;
        if (!candidate) return true;
        // Signing in to the Home already in use chooses no Home. Re-selecting it would mark the
        // selection explicit and turn the welcome corner into that Home's address.
        if (activeServerSnapshot.serverUrl && isSameServerUrl(candidate, activeServerSnapshot.serverUrl)) return true;

        if (canonicalCloudProfile && isSameServerUrl(canonicalCloudProfile.serverUrl, candidate)) {
            const ensuredCloudProfile = canonicalCloudProfile.serverId
                ? { serverId: canonicalCloudProfile.serverId, serverUrl: canonicalCloudProfile.serverUrl }
                : await ensureCanonicalCloudRelayProfile();
            if (ensuredCloudProfile) {
                const switched = await setActiveServerAndSwitch({ serverId: ensuredCloudProfile.serverId, scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()) });
                return switched !== 'blocked';
            }
        }

        return (await connectAndFocusHomeAddress(candidate)) != null;
    }, [activeServerSnapshot.serverUrl, canonicalCloudProfile, connectAndFocusHomeAddress, state.context.relaySelection.serverUrl, welcomeRelayUrl]);

    const handleWelcomeLogin = React.useCallback(async () => {
        if (!await ensureActiveServerForAuth()) return;
        dispatch({ type: 'wizard/goToStep', stepId: 'auth_restore' });
    }, [dispatch, ensureActiveServerForAuth]);
    const handleOpenRestore = handleWelcomeLogin;

    const handleOpenLostAccess = React.useCallback(() => {
        dispatch({ type: 'wizard/goToStep', stepId: 'auth_lost_access' });
    }, []);

    const handleOpenSecretKeyLogin = React.useCallback(() => {
        setAccountDirectoryHomeRecovery(null);
        setAccountDirectoryKeyRequest(null);
        dispatch({ type: 'wizard/goToStep', stepId: 'auth_secret_key' });
    }, []);

    const handleOpenAccountDirectoryKeyLogin = React.useCallback((request: WelcomeAuthenticationMethod) => {
        setAccountDirectoryHomeRecovery(null);
        setAccountDirectoryKeyRequest(request);
        setAccountDirectoryContinuationIntent(props.accountContinuationIntent ?? null);
        dispatch({ type: 'wizard/goToStep', stepId: 'auth_secret_key' });
    }, [props.accountContinuationIntent]);

    const handleContinueWithHomeAuthentication = React.useCallback(async (request: WelcomeAuthenticationMethod, emailProvision?: WelcomeAuthenticationMethod) => {
        if (request.authority.purpose !== 'home') return;
        if (request.execution.kind === 'key_entry') {
            setAccountDirectoryKeyRequest(request);
            dispatch({ type: 'wizard/goToStep', stepId: 'auth_secret_key' });
            return;
        }
        await runWelcomeAuthenticationAction(request, props.onContinueWithHomeAuthentication, emailProvision);
    }, [dispatch, props.onContinueWithHomeAuthentication, runWelcomeAuthenticationAction]);

    const handleContinueWithAccountServiceProvider = React.useCallback(async (request: WelcomeAuthenticationMethod) => {
        await runWelcomeAuthenticationAction(request, props.onContinueWithAccountServiceProvider);
    }, [props.onContinueWithAccountServiceProvider, runWelcomeAuthenticationAction]);

    const handleAccountDirectoryKeyResult = React.useCallback(async (result: AccountDirectoryKeyLoginOutcome) => {
        await props.onAccountDirectoryKeyResult?.(result);
    }, [props.onAccountDirectoryKeyResult]);

    const handleAccountServiceReauthenticate = React.useCallback((input: AccountPostAuthInput) => {
        setAccountDirectoryHomeRecovery(null);
        setAccountDirectoryKeyRequest(null);
        setAccountDirectoryContinuationIntent(input.intent);
        dispatch({ type: 'wizard/goToStep', stepId: 'welcome' });
    }, []);

    const handleOpenAccountDirectoryHomeAuthentication = React.useCallback((
        input: AccountPostAuthInput,
        homeServerIdentityId: string,
        previous: AccountPostAuthResult,
    ) => {
        setAccountDirectoryHomeRecovery({ kind: 'home_auth', input, previous, homeServerIdentityId });
    }, []);

    const handleAccountDirectoryHomeAuthenticationResult = React.useCallback(async (
        result: AccountPostAuthResult,
        input?: AccountPostAuthInput,
    ) => {
        await props.onAccountDirectoryKeyResult?.(result);
        // Shared host rule: Done / Open {Home} results keep their card here exactly as in the account-entry route.
        if (shouldDismissAccountPostAuthContinuation(result)) {
            setAccountDirectoryHomeRecovery(null);
            return;
        }
        setAccountDirectoryHomeRecovery((current) => current ? {
            ...current,
            kind: 'continuation',
            input: input ?? current.input,
            previous: result,
        } : current);
    }, [props.onAccountDirectoryKeyResult]);

    const handleAccountDirectoryHomeAuthenticationBack = React.useCallback(() => {
        setAccountDirectoryHomeRecovery(null);
        setAccountDirectoryKeyRequest(null);
        handleBackToWelcome();
    }, [handleBackToWelcome]);

    const handleOpenAccountServiceSelection = React.useCallback(() => {
        dispatch({ type: 'wizard/goToStep', stepId: 'auth_service_select' });
    }, []);

    const handleRelaySelectAdvance = React.useCallback(async () => {
        const isManualRelayEntry =
            state.context.relaySelection.choiceId === 'customUrl'
            && !state.context.relaySelection.relayProfileId
            && !String(state.context.relaySelection.serverUrl ?? '').trim();
        const relayUrl = isManualRelayEntry
            ? null
            : (selectedRelayFooterUrl || snapshotRelayUrl || null);
        const choiceId = state.context.relaySelection.choiceId;
        const settingUpHome = choiceId === 'remoteComputer' || (choiceId === 'thisComputer' && props.isDesktopShell);
        if (await handleAdvance() && !settingUpHome) {
            setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
        }
    }, [
        handleAdvance,
        props.isDesktopShell,
        selectedRelayFooterUrl,
        snapshotRelayUrl,
        state.context.relaySelection.choiceId,
        state.context.relaySelection.relayProfileId,
        state.context.relaySelection.serverUrl,
    ]);

    const handleRelayAccessAdvance = React.useCallback(async () => {
        if (preparedPersonalHome) {
            if (await connectAndFocusHomeAddress(preparedPersonalHome.serverUrl)) {
                dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
            }
            return;
        }
        setRelaySwitchDecision('switch');
        dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: true });
        dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
    }, [connectAndFocusHomeAddress, dispatch, preparedPersonalHome]);

    const handleRelayAccessProviderIdChange = React.useCallback((providerId: RelayAccessProviderId | null) => {
        dispatch({ type: 'wizard/setRelayAccessProviderId', providerId });
    }, [dispatch]);

    const handleRelayAccessProviderDetailsRequested = React.useCallback((providerId: RelayAccessProviderId) => {
        dispatch({ type: 'wizard/setRelayAccessProviderId', providerId });
        dispatch({
            type: 'wizard/goToStep',
            stepId: 'relay_access_prereqs',
        });
    }, [dispatch]);

    const skipLabel = React.useMemo(() => {
        if (stepId === 'welcome') return welcomeHasAuthActions ? t('common.login') : t('common.start');
        return t('common.skip');
    }, [stepId, welcomeHasAuthActions]);

    const onSkip = React.useMemo(() => {
        if (activeSkipOverride) {
            if (activeSkipOverride.hidden) return undefined;
            return activeSkipOverride.onPress ?? (() => undefined);
        }
        if (!showSkip) return undefined;
        if (stepId === 'welcome') {
            return welcomeHasAuthActions
                ? () => handleWelcomeLogin()
                : () => handleWelcomeAdvance();
        }
        return () => dispatch({ type: 'wizard/advance' });
    }, [
        handleWelcomeAdvance,
        handleWelcomeLogin,
        showSkip,
        stepId,
        welcomeHasAuthActions,
        activeSkipOverride,
    ]);

    const skipDisabled = restoreNavigationLocked || (activeSkipOverride?.disabled ?? (
        showSkip && stepId === 'welcome'
            ? primaryDisabled
            : false
    ));

    const onPrimary =
        activePrimaryOverride
            ? activePrimaryOverride.onPress
            : stepId === 'welcome'
                ? (welcomeHasKnownRelay ? undefined : handleWelcomeAdvance)
                : stepId === 'auth_secret_key'
                    ? undefined
                : stepId === 'relay_enter_url'
                    ? handleSaveCustomRelayUrl
                    : stepId === 'relay_select'
                        ? handleRelaySelectAdvance
                    : stepId === 'desktop_handoff'
                        ? () => {
                            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'thisComputer', serverUrl: null, relayProfileId: null, locked: false } });
                            dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
                        }
                    : stepId === 'background_service_handoff'
                        ? () => dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' })
                        : stepId === 'host_relay_local'
                        ? startPersonalHome
                        : stepId === 'relay_access'
                            ? handleRelayAccessAdvance
                        : stepId === 'relay_access_prereqs'
                            ? handleRelayAccessAdvance
                        : stepId === 'host_relay_remote'
                            ? async () => {
                                const relayUrlRaw = typeof state.context.relaySelection.serverUrl === 'string'
                                    ? state.context.relaySelection.serverUrl.trim()
                                    : '';
                                const relayUrl = relayUrlRaw ? normalizeServerUrl(relayUrlRaw) : null;
                                if (!relayUrl) {
                                    await Modal.alert(t('common.error'), t('modals.invalidAuthUrl'));
                                    return;
                                }
                                setRelaySwitchDecision('switch');
                                dispatch({
                                    type: 'wizard/setRelaySelection',
                                    relaySelection: {
                                        choiceId: 'remoteComputer',
                                        serverUrl: relayUrl,
                                        relayProfileId: state.context.relaySelection.relayProfileId ?? null,
                                        locked: false,
                                    },
                                });
                                dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
                            }
                        : stepId === 'confirm_switch_relay'
                            ? async () => {
                                const relayUrl = resolveRelaySwitchUrl({
                                    relayRuntimeUrl: state.context.relaySelection.serverUrl,
                                    relayAccessShareUrl,
                                    relayAccessTarget,
                                });
                                if (!relayUrl) {
                                    dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: false });
                                    dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
                                    return;
                                }

                                if (relaySwitchDecision === 'switch') {
                                    const profile = await connectAndFocusHomeAddress(relayUrl);
                                    if (!profile) return;
                                    dispatch({
                                        type: 'wizard/setRelaySelection',
                                        relaySelection: {
                                            choiceId: state.context.relaySelection.choiceId ?? 'customUrl',
                                            serverUrl: profile.serverUrl,
                                            relayProfileId: profile.id,
                                            locked: false,
                                        },
                                    });
                                    setOnboardingWizardAwaitingAuthResumeIntent(profile.serverUrl);
                                } else {
                                    const fallbackSelection = buildDefaultRelaySelection();
                                    dispatch({ type: 'wizard/setRelaySelection', relaySelection: fallbackSelection });
                                    setOnboardingWizardAwaitingAuthResumeIntent(fallbackSelection.serverUrl);
                                }

                                dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: false });
                                dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
                            }
                    : undefined;

    const onBack =
        activeBackOverride?.hidden
            ? undefined
            : (activeBackOverride?.onPress ?? (showBack ? handleBack : undefined));

    let body: React.ReactNode = null;
    const relaySelectionServerUrl = typeof state.context.relaySelection.serverUrl === 'string'
        ? state.context.relaySelection.serverUrl.trim()
        : null;
    const confirmRelayUrl = resolveRelaySwitchUrl({
        relayRuntimeUrl: relaySelectionServerUrl,
        relayAccessShareUrl,
        relayAccessTarget,
    });
    const relayChoices = ([
            ...profileChoices.map(buildRelayChoiceItem),
            ...addHomePaths.map((path) => {
                if (path.id === 'direct') return buildManualRelayChoiceItem();
                if (path.id === 'service') return buildRelayChoiceItem({
                    id: 'cloud', title: t('setupOnboarding.relayCloudTitle'),
                    subtitle: t('setupOnboarding.relayCloudSubtitle'), icon: 'cloud',
                });
                if (path.place === 'ssh') return buildRelayChoiceItem({
                    id: 'remoteComputer', title: t('addFlows.pathSshTitle'),
                    subtitle: t('setupOnboarding.relayOnRemoteComputerSubtitle'), icon: 'desktop',
                });
                const isYourComputer = wizardCapabilities.thisComputerLabelVariant === 'your';
                return buildRelayChoiceItem({
                    id: 'thisComputer',
                    title: t(isYourComputer ? 'setupOnboarding.relayOnYourComputerTitle' : 'setupOnboarding.relayOnThisComputerTitle'),
                    subtitle: t(isYourComputer ? 'setupOnboarding.relayOnYourComputerSubtitle' : 'setupOnboarding.relayOnThisComputerSubtitle'),
                    icon: 'laptop',
                });
            }),
    ] as ReadonlyArray<RelayChoiceItem | null>).filter((choice): choice is RelayChoiceItem => choice !== null);
    // Where should your Home live? Option F cards: two columns where they fit, one on a phone (plan 03 shared
    // components 1); a choice's own operations stand beside its card, outside the choice.
    const relaySelectBody = (
        <WideStepColumn>
            <SelectionTiles
                variant="card"
                // Option F: the glyph sits inline at the title's size (lab 16 px), the card's text at the compact step.
                density="compact"
                accessibilityLabel={t('setupOnboarding.preAuthTitle')}
                options={relayChoices as Array<SelectionTile<string>>}
                value={relayChoices.find((choice) => choice.selected)?.id ?? null}
                onChange={(id) => {
                    if (id !== null) relayChoices.find((choice) => choice.id === id)?.onSelect();
                }}
                maximumColumns={2}
                minimumTileWidth={RELAY_CHOICE_MIN_TILE_WIDTH_PX}
                footerPlacement="trailing"
                renderOptionFooter={({ option }) => {
                    const choice = relayChoices.find((candidate) => candidate.id === option.id);
                    return choice && (choice.secondaryAction || choice.menuActions?.length)
                        ? <RelayChoiceActions testID={choice.testID ?? choice.id} retry={choice.secondaryAction} menuActions={choice.menuActions} />
                        : null;
                }}
            />
        </WideStepColumn>
    );
    const restoreTargetProfileId = stepId === 'auth_restore'
        ? resolveReverseQrTargetProfileId(activeServerSnapshot.serverId) ?? undefined
        : undefined;
    const selectedProfile = preparedPersonalHome?.id === activeServerSnapshot.serverId && props.isHomeAuthenticated && stepId === 'auth'
        ? preparedPersonalHome
        : null;
    body = renderOnboardingWizardStepBody({
        stepId,
        testIDPrefix: props.testID ?? 'onboarding-wizard',
        styles,
        theme,
        layout: props.layout,
        isDesktopShell: props.isDesktopShell,
        authEntryOptions: props.authEntryOptions,
        accountServiceEntry: props.accountServiceEntry,
        accountContinuationIntent: accountDirectoryContinuationIntent
            ?? props.accountContinuationIntent
            ?? { kind: 'enter', target: { kind: 'automatic' } },
        accountDirectoryKeyRequest,
        accountDirectoryHomeRecovery,
        emailPasswordRequest,
        oauthBrowserWait,
        onEmailPasswordClose: () => {
            setEmailPasswordRequest(null);
            dispatch({ type: 'wizard/back' });
        },
        accountEntryReturnTo: props.accountEntryReturnTo,
        restoreInitialView: canScanQr ? 'scanner' : !loginLeadsWithLink && restoreTargetProfileId ? 'qr' : 'paste',
        restoreTargetProfileId,
        canScanQr,
        welcomeHasKnownRelay,
        welcomeHasAuthActions,
        allowRelaySelection: setupPolicy.relay.allowRelaySelection,
        canCreatePersonalHome,
        relaySelectBody,
        urlDraft,
        onUrlDraftChange: changeHomeAddress,
        onHomeAddressSubmit: primaryDisabled ? undefined : handleSaveCustomRelayUrl,
        homeAddressError,
        relaySelectionServerUrl,
        confirmRelayUrl,
        serverProfileId: state.context.relaySelection.relayProfileId ?? null,
        relayAccessTarget: relayAccessTarget ?? defaultRelayAccessTarget,
        runWithRelayAccessTarget: relayAccessTarget ? relayAccessRunnerRef.current : undefined,
        relayAccessRemoteHost: relayAccessTarget ? relayAccessRemoteHostRef.current : undefined,
        lastKnownSnapshotRelayUrl: lastKnownSnapshotRelayUrlRef.current || '',
        reachabilityRemediation: activeReachabilityRemediation,
        reachabilityRemediationTaskSnapshot: tailscaleEnsureReadySnapshot,
        reachabilityRemediationError,
        onReachabilityRemediationAction: handleReachabilityRemediationAction,
        onRelayAccessShareUrlChange: handleRelayAccessShareUrlChange,
        relaySwitchDecision,
        onRelaySwitchDecisionChange: setRelaySwitchDecision,
        onWizardPrimaryChange: handleWizardPrimaryChange,
        onWizardBackChange: handleWizardBackChange,
        onWizardSkipChange: handleWizardSkipChange,
        relayAccessProviderId: state.context.relayAccessProviderId,
        onRelayAccessProviderIdChange: handleRelayAccessProviderIdChange,
        onRelayAccessProviderDetailsRequested: handleRelayAccessProviderDetailsRequested,
        // Deliberately not preceded by `ensureActiveServerForAuth()`: sign-in-service
        // authentication is targeted at the selected service and must not touch the focused Home.
        onContinueWithAccountServiceProvider: handleContinueWithAccountServiceProvider,
        onContinueWithAccountServiceKey: props.accountContinuationIntent && props.onAccountDirectoryKeyResult
            ? handleOpenAccountDirectoryKeyLogin
            : undefined,
        onAccountDirectoryKeyResult: handleAccountDirectoryKeyResult,
        onAccountServiceReauthenticate: handleAccountServiceReauthenticate,
        onChooseAccountService: props.onSelectAccountService ? handleOpenAccountServiceSelection : undefined,
        onContinueWithHomeAuthentication: handleContinueWithHomeAuthentication,
        onSelectAccountService: handleSelectAccountService,
        onAccountServiceSelectionBack: handleBack,
        onAccountDirectoryKeyBack: () => {
            setAccountDirectoryHomeRecovery(null);
            setAccountDirectoryKeyRequest(null);
            dispatch({ type: 'wizard/back' });
        },
        onOpenAccountDirectoryHomeAuthentication: handleOpenAccountDirectoryHomeAuthentication,
        onAccountDirectoryHomeAuthenticationResult: handleAccountDirectoryHomeAuthenticationResult,
        onAccountDirectoryHomeAuthenticationBack: handleAccountDirectoryHomeAuthenticationBack,
        onOpenRelaySelectionFromWelcome: handleOpenRelaySelectionFromWelcome,
        onOpenConnectHome: canConnectHomeByAddress(setupPolicy) ? handleOpenConnectHome : undefined,
        onBackToWelcome: handleBackToWelcome,
        connectHomeInitialAddress: props.initialServerUrl,
        onConnectHomeReached: props.onInitialServerUrlConnected,
        onOpenRelaySelectionFromAuth: handleOpenRelaySelectionPreservingSelection,
        onCreatePersonalHome: canCreatePersonalHome ? startPersonalHome : undefined,
        preparedHome: selectedProfile && firstRunPersonalHome ? { profile: selectedProfile, onOpened: firstRunPersonalHome.finish } : undefined,
        onOpenRestore: handleOpenRestore,
        onOpenLostAccess: handleOpenLostAccess,
        onOpenSecretKeyLogin: handleOpenSecretKeyLogin,
        onRestoreBackToAuth: handleBack,
        onRestoreNavigationLockChange: setRestoreNavigationLocked,
        onRelayAccessAdvance: handleRelayAccessAdvance,
        onHostRelayRemoteAdvance: () => dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' }),
        onHostRelayRemoteCancel: () => dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' }, 'back'),
        onRemoteRelayRuntimeCompleted: handleRemoteRelayRuntimeCompletedChange,
    });

    const resolvedOnBack = onBack ?? null;

    return {
        stepId,
        currentStepIndex,
        stepCount: Math.max(1, progress.total),
        showBack: Boolean(resolvedOnBack),
        showSkip: activeSkipOverride ? !activeSkipOverride.hidden : undefined,
        navigationLocked: restoreNavigationLocked,
        onBack: resolvedOnBack,
        onSkip: onSkip ?? null,
        onPrimary: onPrimary ?? null,
        primaryLabel: activePrimaryOverride?.label ?? primaryLabel,
        primaryDisabled: activePrimaryOverride?.disabled ?? primaryDisabled,
        skipLabel: activeSkipOverride?.label ?? skipLabel,
        skipDisabled,
        title,
        subtitle,
        bodyOwnsHeading: stepDefinition.bodyOwnsHeading === true,
        footerHint,
        homeContext,
        body,
        goToStep: (nextStepId: WizardStepId) => {
            dispatch({ type: 'wizard/goToStep', stepId: nextStepId });
        },
    };
}
