import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { Text } from '@/components/ui/text/Text';
import { ActiveRelaySummary } from '@/components/onboarding/ui/ActiveRelaySummary';
import {
    resolveStepTransitionDirection,
    type StepTransitionDirection,
} from '@/components/ui/motion/StepTransitionFrame';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

import { isSameServerUrl, normalizeServerUrl, setActiveServerAndSwitch, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerSnapshot, upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { readConfiguredServerUrlEnv } from '@/sync/domains/server/readConfiguredServerUrlEnv';
import { listServerProfiles, removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { removeServerProfileUiAction } from '@/components/serverProfiles/removeServerProfileUiAction';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';
import { useEndpointReachabilityRemediationController } from '@/components/settings/server/hooks/useEndpointReachabilityRemediationController';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { isLocalishServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { readServerReachabilityProbeTimeoutMs } from '@/sync/runtime/connectivity/serverReachabilityTuning';
import {
    getEndpointReachabilityProvider,
    resolveEndpointReachabilityRemediation,
    type EndpointReachabilityRemediation,
} from '@/components/serverReachability/remediation';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebQrScannerSupported } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import type { RelayHostLocalChecklistRuntimeStatus } from '../checklists/relayHostLocal/types';
import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { WebDesktopRelayHostHandoffContent } from '@/components/onboarding/steps/webDesktop/WebDesktopRelayHostHandoffContent';
import { WebDesktopBackgroundServiceHandoffContent } from '@/components/onboarding/steps/webDesktop/WebDesktopBackgroundServiceHandoffContent';
import { resolveWizardCapabilities } from '../capabilities/resolveWizardCapabilities';
import { canSkipWizardStep, getWizardProgress } from '../state/wizardSelectors';
import { createWizardState, wizardReducer } from '../state/wizardReducer';
import type { WizardPlatform, WizardRelaySelection, WizardStepId } from '../state/wizardTypes';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from '../steps/ConfirmSwitchRelayStep';
import { parseOnboardingScanPayload } from '../state/scanPayload';
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
import { renderWizardChoiceList, type WizardChoiceListItem } from './WizardChoiceList';
import {
    buildDefaultRelaySelection,
    ensureCanonicalCloudRelayProfile,
    isWebMixedContentBlockedEndpoint,
    resolveCanonicalCloudRelayProfile,
    resolveRelayProfileIdForServerUrl,
    resolveRelaySwitchUrl,
    resolveTrueLocalRelayRuntimeBindUrl,
} from './relaySelection/relaySelectionHelpers';
import { useWizardChromeOverrides } from '../hooks/useWizardChromeOverrides';
import type { WizardChoice, WizardProfileChoice } from './relaySelection/relaySelectionTypes';
import { buildRelayChoices } from './relaySelection/buildRelayChoices';
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
    initialStepId?: WizardStepId;

    onCreateAccount: () => Promise<void> | void;
    onCreateAccountViaProvider: (providerId: string) => Promise<void> | void;
    onLoginWithKeylessProvider: (providerId: string) => Promise<void> | void;
    onLoginWithMtls: () => Promise<void> | void;
}>;

export type OnboardingWizardController = Readonly<{
    stepId: WizardStepId;
    currentStepIndex: number;
    stepCount: number;
    contentTransitionDirection: StepTransitionDirection;
    showBack: boolean;
    showSkip: boolean | undefined;
    onBack: (() => void) | null;
    onSkip: (() => Promise<void> | void) | null;
    onPrimary: (() => Promise<void> | void) | null;
    primaryLabel: React.ReactNode;
    primaryDisabled: boolean;
    skipLabel: React.ReactNode | null;
    skipDisabled: boolean;
    title: string;
    subtitle: string | null;
    footerHint: React.ReactNode | null;
    body: React.ReactNode;
    goToStep: (stepId: WizardStepId) => void;
}>;

function resolveCanScanQr(params: Readonly<{ width: number; height: number; platform: string }>): boolean {
    if (isRunningOnMac()) return false;
    if (params.platform !== 'web') return true;
    if (!isWebQrScannerSupported()) return false;
    return isWebMobileLikeQrScannerHost({ width: params.width, height: params.height });
}

export function useOnboardingWizardController(props: OnboardingWizardSurfaceProps): OnboardingWizardController {
    const { theme } = useUnistyles();
    const styles = onboardingWizardSurfaceStylesheet;
    const { width, height } = useWindowDimensions();
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

    const qrScannerHeuristicViewport = React.useMemo(() => {
        if (Platform.OS !== 'web') {
            return { width, height };
        }
        if (!props.isDesktopShell) {
            return { width, height };
        }
        const screen =
            (globalThis as unknown as { screen?: unknown }).screen
            ?? (typeof window !== 'undefined' ? window.screen : null);
        const screenWidth = typeof (screen as { availWidth?: unknown } | null)?.availWidth === 'number'
            ? Number((screen as { availWidth: number }).availWidth)
            : (typeof (screen as { width?: unknown } | null)?.width === 'number' ? Number((screen as { width: number }).width) : 0);
        const screenHeight = typeof (screen as { availHeight?: unknown } | null)?.availHeight === 'number'
            ? Number((screen as { availHeight: number }).availHeight)
            : (typeof (screen as { height?: unknown } | null)?.height === 'number' ? Number((screen as { height: number }).height) : 0);
        if (Number.isFinite(screenWidth) && Number.isFinite(screenHeight) && screenWidth > 0 && screenHeight > 0) {
            return { width: screenWidth, height: screenHeight };
        }
        return { width, height };
    }, [height, props.isDesktopShell, width]);

    const canScanQr = React.useMemo(
        () => resolveCanScanQr({ width: qrScannerHeuristicViewport.width, height: qrScannerHeuristicViewport.height, platform: Platform.OS }),
        [qrScannerHeuristicViewport.height, qrScannerHeuristicViewport.width],
    );

    const [urlDraft, setUrlDraft] = React.useState('');
    const [relaySwitchDecision, setRelaySwitchDecision] = React.useState<RelaySwitchDecision>('switch');
    type LocalRelayRuntimeStatus = RelayHostLocalChecklistRuntimeStatus | null;
    const [localRelayRuntimeStatus, setLocalRelayRuntimeStatus] = React.useState<LocalRelayRuntimeStatus>(null);
    const [relayAccessTarget, setRelayAccessTarget] = React.useState<RelayAccessTaskTarget | null>(null);
    const [relayAccessShareUrl, setRelayAccessShareUrl] = React.useState<string | null>(null);
    const defaultRelayAccessTarget = React.useMemo<RelayAccessTaskTarget>(() => ({ kind: 'local' }), []);
    const [state, dispatch] = React.useReducer(
        wizardReducer,
        null,
        () => {
            const context = {
                mode: 'onboarding',
                platform: props.isDesktopShell ? 'desktop' : (Platform.OS === 'web' ? 'web' : 'native'),
                canScanQr,
                scanStepEnabled: false,
                canRunSystemTasks: props.isDesktopShell,
                relaySelection: buildDefaultRelaySelection(),
                relayAccessProviderId: null,
                relayLockConfirmationPending: false,
                relaySwitchConfirmationPending: false,
                authIntent: 'standard',
                setupAction: null,
            } as const;

            const requestedStepId = props.initialStepId ?? 'welcome';
            const isRequestedVisible = getWizardStepDefinition(requestedStepId).visibleWhen(context);
            const initialStepId = isRequestedVisible ? requestedStepId : 'welcome';

            return createWizardState({
                context: {
                    ...context,
                },
                currentStepId: initialStepId,
                history: [],
                resumeState: null,
                parsedScanPayload: null,
            });
        },
    );

    const handleLocalRelayRuntimeStatusChange = React.useCallback((status: LocalRelayRuntimeStatus) => {
        setLocalRelayRuntimeStatus(status);
        const relayUrl = typeof status?.relayUrl === 'string' ? status.relayUrl.trim() : '';
        if (!relayUrl) {
            return;
        }
        setRelayAccessTarget({ kind: 'local' });
        setRelayAccessShareUrl(null);
        const profile = upsertServerProfileOnly({
            serverUrl: relayUrl,
            source: 'url',
        });
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: {
                choiceId: 'thisComputer',
                serverUrl: relayUrl,
                relayProfileId: profile.id,
                locked: false,
            },
        });
    }, [dispatch]);

    const applyWizardAdvanceResolution = React.useCallback(async (resolution: WizardAdvanceResolution) => {
        for (const effect of resolution.effects) {
            switch (effect.type) {
                case 'activateServerUrl':
                    await upsertActivateAndSwitchServer({
                        serverUrl: effect.serverUrl,
                        source: effect.source,
                        scope: effect.scope,
                    });
                    break;
                case 'activateServerProfile':
                    await setActiveServerAndSwitch({
                        serverId: effect.serverId,
                        scope: effect.scope,
                    });
                    break;
                case 'setRelaySelection':
                    dispatch({ type: 'wizard/setRelaySelection', relaySelection: effect.relaySelection });
                    break;
                case 'persistOnboardingIntent':
                    setOnboardingWizardAwaitingAuthResumeIntent(effect.relayUrl);
                    break;
                case 'clearRelayAccessDraft':
                    setRelayAccessTarget(null);
                    setRelayAccessShareUrl(null);
                    break;
                case 'setRelayRuntimeCandidate':
                case 'setPendingSetupIntent':
                case 'exitSetup':
                case 'navigate':
                    break;
            }
        }

        if (resolution.nextStepId) {
            dispatch({ type: 'wizard/goToStep', stepId: resolution.nextStepId });
        }
    }, [dispatch]);

    const stepId = state.currentStepId;
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
        const fallbackRelayUrl =
            state.context.relaySelection.choiceId === 'customUrl'
            && (
                state.context.relaySelection.relayProfileId === 'active'
                || state.context.relaySelection.relayProfileId == null
            )
                ? snapshotRelayUrl
                : '';
        const resolved = selectedRelayUrl || fallbackRelayUrl;
        if (!resolved) return;
        setUrlDraft(resolved);
    }, [
        snapshotRelayUrl,
        state.context.relaySelection.choiceId,
        state.context.relaySelection.relayProfileId,
        state.context.relaySelection.serverUrl,
        stepId,
        urlDraft,
    ]);
    const progress = getWizardProgress(state.context, stepId);
    const currentStepIndex = Math.max(0, progress.current - 1);
    const transitionSnapshotRef = React.useRef<Readonly<{
        stepId: WizardStepId;
        stepIndex: number;
        historyLength: number;
        direction: StepTransitionDirection;
    }>>({
        stepId,
        stepIndex: currentStepIndex,
        historyLength: state.history.length,
        direction: 'replace',
    });
    const previousTransition = transitionSnapshotRef.current;
    let contentTransitionDirection = previousTransition.direction;
    if (previousTransition.stepId !== stepId) {
        const indexTransitionDirection = resolveStepTransitionDirection({
            previousIndex: previousTransition.stepIndex,
            nextIndex: currentStepIndex,
        });
        contentTransitionDirection = indexTransitionDirection !== 'replace'
            ? indexTransitionDirection
            : state.history.length > previousTransition.historyLength
                ? 'forward'
                : state.history.length < previousTransition.historyLength
                    ? 'backward'
                    : 'forward';
        transitionSnapshotRef.current = {
            stepId,
            stepIndex: currentStepIndex,
            historyLength: state.history.length,
            direction: contentTransitionDirection,
        };
    } else if (
        previousTransition.stepIndex !== currentStepIndex
        || previousTransition.historyLength !== state.history.length
    ) {
        transitionSnapshotRef.current = {
            ...previousTransition,
            stepIndex: currentStepIndex,
            historyLength: state.history.length,
        };
    }
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

    const relayChoices: readonly WizardChoice[] = React.useMemo(() => buildRelayChoices({
        wizardCapabilities,
        setupPolicy,
    }), [setupPolicy, wizardCapabilities]);

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

    const relayEnterUrlEndpointForReadiness = React.useMemo(() => {
        if (stepId !== 'relay_enter_url') {
            return null;
        }
        const trimmed = urlDraft.trim();
        return trimmed ? normalizeServerUrl(trimmed) : null;
    }, [stepId, urlDraft]);

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
        timeoutMs: readServerReachabilityProbeTimeoutMs(),
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
        setRelayAccessTarget(null);
        setRelayAccessShareUrl(null);
        dispatch({ type: 'wizard/setRelaySelection', relaySelection: next });
    }, [canonicalCloudUrl, state.context.relaySelection]);

    const selectProfileRelay = React.useCallback((profile: WizardProfileChoice) => {
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

    const buildRelayChoiceItem = (choice: WizardChoice | WizardProfileChoice): WizardChoiceListItem => {
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
                itemKey: `profile:${profile.id}`,
                testID: `${props.testID ?? 'onboarding-wizard'}-relay:profile:${profile.id}`,
                selected,
                disabled,
                dimmed: unavailable || blocked,
                onPress: () => selectProfileRelay(profile),
                icon: 'link',
                title: profile.name,
                subtitle: toServerUrlDisplay(profile.serverUrl),
                badge: blocked ? t('common.blocked') : unavailable ? t('common.unreachable') : undefined,
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
            itemKey: fixed.id,
            testID: `${props.testID ?? 'onboarding-wizard'}-relay:${fixed.id}`,
            selected,
            disabled,
            dimmed: cloudUnavailable || cloudBlocked,
            onPress: () => {
                selectRelayChoice(fixed.id);
            },
            icon: fixed.icon,
            title: fixed.title,
            subtitle: fixed.subtitle,
            badge: cloudBlocked ? t('common.blocked') : cloudUnavailable ? t('common.unreachable') : fixed.badge,
            secondaryAction: (cloudUnavailable || cloudBlocked) ? {
                testID: `${props.testID ?? 'onboarding-wizard'}-relay:${fixed.id}-retry`,
                title: t('common.retry'),
                onPress: () => retryEndpoint(cloudReadinessEndpoint!),
            } : undefined,
        };
    };

    const buildManualRelayChoiceItem = (): WizardChoiceListItem | null => {
        if (!setupPolicy.relay.allowRelaySelection || !setupPolicy.relay.allowCustomRelayUrl) {
            return null;
        }
        const rawServerUrl = state.context.relaySelection.serverUrl
            ? String(state.context.relaySelection.serverUrl).trim()
            : '';
        const selected = state.context.relaySelection.choiceId === 'customUrl'
            && !state.context.relaySelection.relayProfileId
            && !selectedSavedRelayProfile;

        return {
            itemKey: 'customUrl',
            testID: `${props.testID ?? 'onboarding-wizard'}-relay:customUrl`,
            selected,
            disabled: state.context.relaySelection.locked && !selected,
            onPress: () => {
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
            ? ensureCanonicalCloudRelayProfile()
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

        await applyWizardAdvanceResolution(resolveWizardAdvance(
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
        mode: 'remoteMachine' | 'remoteRelayHost';
    }>) => {
        const relayUrl = typeof payload.relayRuntimeUrl === 'string' ? payload.relayRuntimeUrl.trim() : '';
        if (!relayUrl) {
            return;
        }

        setRelaySwitchDecision('switch');
        setRelayAccessTarget(payload.relayAccessTarget);
        setRelayAccessShareUrl(null);
        const relayProfile = upsertServerProfileOnly({
            serverUrl: relayUrl,
            source: 'url',
        });
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: {
                choiceId: 'remoteComputer',
                serverUrl: relayUrl,
                relayProfileId: relayProfile.id,
                locked: false,
            },
        });
        setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
    }, [dispatch]);

    const handleRelayAccessShareUrlChange = React.useCallback((shareUrl: string | null) => {
        const normalized = typeof shareUrl === 'string' ? shareUrl.trim() : '';
        setRelayAccessShareUrl(normalized || null);
    }, []);

    const handleBack = React.useCallback(() => {
        if (stepId === 'scan_code') {
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
        }
        dispatch({ type: 'wizard/back' });
    }, [stepId]);

    const handleBackToWelcome = React.useCallback(() => {
        dispatch({ type: 'wizard/goToStep', stepId: 'welcome' });
    }, []);

    const handleOpenRelaySelectionFromWelcome = React.useCallback(() => {
        if (!setupPolicy.relay.allowRelaySelection) {
            return;
        }
        if (!state.context.relaySelection.locked) {
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: buildDefaultRelaySelection() });
        }
        dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
    }, [setupPolicy.relay.allowRelaySelection, state.context.relaySelection.locked]);

    const handleOpenRelaySelectionPreservingSelection = React.useCallback(() => {
        if (!setupPolicy.relay.allowRelaySelection) {
            return;
        }
        dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
    }, [setupPolicy.relay.allowRelaySelection]);

    const handleScan = React.useCallback(async (data: string) => {
        const parsed = parseOnboardingScanPayload(data);
        setRelayAccessTarget(null);
        setRelayAccessShareUrl(null);
        dispatch({ type: 'wizard/setParsedScanPayload', parsedScanPayload: parsed });
        if (parsed.kind === 'pairing_link' && parsed.serverUrl == null) {
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: null, relayProfileId: null, locked: true } });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
            return;
        }
        if (parsed.kind === 'relay_url') {
            const relayProfileId = resolveRelayProfileIdForServerUrl({ serverUrl: parsed.serverUrl, canonicalCloudUrl });
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: parsed.serverUrl, relayProfileId, locked: false } });
            dispatch({ type: 'wizard/setRelayLockConfirmationPending', pending: true });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'confirm_relay_lock' });
            return;
        }
        if (parsed.kind === 'pairing_link') {
            dispatch({ type: 'wizard/setAuthIntent', authIntent: 'restore' });
            const relayProfileId = resolveRelayProfileIdForServerUrl({ serverUrl: parsed.serverUrl, canonicalCloudUrl });
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: parsed.serverUrl, relayProfileId, locked: false } });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            if (parsed.serverUrl) {
                dispatch({ type: 'wizard/setRelayLockConfirmationPending', pending: true });
                dispatch({ type: 'wizard/goToStep', stepId: 'confirm_relay_lock' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
            return;
        }
        if (parsed.kind === 'account_connect') {
            dispatch({ type: 'wizard/setAuthIntent', authIntent: 'restore' });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'auth_restore' });
            return;
        }
        await Modal.alert(t('common.error'), t('modals.invalidAuthUrl'));
    }, [canonicalCloudUrl]);

    const handleSaveCustomRelayUrl = React.useCallback(async () => {
        const trimmed = urlDraft.trim();
        const normalized = normalizeServerUrl(trimmed);
        if (!normalized) {
            await Modal.alert(t('common.error'), t('modals.invalidAuthUrl'));
            return;
        }
        const isThisComputerHandoff =
            (state.context.platform === 'web' || state.context.platform === 'native')
            && state.context.relaySelection.choiceId === 'thisComputer';
        const relayProfileId = isThisComputerHandoff
            ? null
            : resolveRelayProfileIdForServerUrl({ serverUrl: normalized, canonicalCloudUrl });
        await applyWizardAdvanceResolution(resolveWizardAdvance(
            state,
            wizardStepRegistry,
            {
                type: 'saveCustomRelayUrl',
                relayUrl: normalized,
                relayProfileId,
            },
        ));
    }, [applyWizardAdvanceResolution, canonicalCloudUrl, state, urlDraft]);

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
    const title = t(stepDefinition.titleKey);
    const subtitle = stepDefinition.subtitleKey ? t(stepDefinition.subtitleKey) : null;

    const primaryLabel =
        stepId === 'welcome'
            ? t('setupOnboarding.letsStart')
            : stepId === 'confirm_relay_lock'
                ? t('setupOnboarding.confirmSwitchRelaySwitchTitle')
            : stepId === 'desktop_handoff'
                ? t('setupOnboarding.webDesktopOnlyPrimary')
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

    const footerHint = React.useMemo(() => {
        if (stepId === 'scan_code') return null;
        if (stepId === 'relay_select') {
            const resolvedRelayUrl = selectedRelayFooterUrl || lastKnownSnapshotRelayUrlRef.current;
            if (!resolvedRelayUrl) return null;
            const status = snapshotRelayUrl && isSameServerUrl(snapshotRelayUrl, resolvedRelayUrl)
                ? 'active'
                : 'selected';
            return (
                <ActiveRelaySummary
                    idPrefix={`${props.testID ?? 'onboarding-wizard'}-relay-hint`}
                    relayUrl={resolvedRelayUrl}
                    status={status}
                />
            );
        }
        if (stepId === 'welcome' && !welcomeHasKnownRelay) return null;
        const rawRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        const fallbackRelayUrl = welcomeRelayUrl || lastKnownSnapshotRelayUrlRef.current;
        const resolvedRelayUrl = stepId === 'welcome'
            ? (welcomeRelayUrl || rawRelayUrl || lastKnownSnapshotRelayUrlRef.current)
            : (rawRelayUrl || fallbackRelayUrl);
        if (!resolvedRelayUrl) return null;
        return (
            <ActiveRelaySummary
                idPrefix={`${props.testID ?? 'onboarding-wizard'}-relay-hint`}
                relayUrl={resolvedRelayUrl}
                status="active"
            />
        );
    }, [
        selectedRelayFooterUrl,
        snapshotRelayUrl,
        state.context.relaySelection.choiceId,
        state.context.relaySelection.serverUrl,
        stepId,
        welcomeHasKnownRelay,
        welcomeRelayUrl,
    ]);

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

    const primaryDisabled =
        (stepId === 'relay_select' && (
            state.context.relaySelection.choiceId == null
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
        || (stepId === 'host_relay_local' && !localRelayRuntimeStatus?.relayUrl)
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

    const ensureActiveServerForAuth = React.useCallback(async () => {
        const rawRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        const fallbackRelayUrl = welcomeRelayUrl ? String(welcomeRelayUrl).trim() : '';
        const candidate = rawRelayUrl || fallbackRelayUrl;
        const normalized = candidate ? normalizeServerUrl(candidate) : null;
        if (!normalized) return;

        const snapshot = getActiveServerSnapshot();
        if (isSameServerUrl(snapshot.serverUrl, normalized)) return;

        if (canonicalCloudProfile && isSameServerUrl(canonicalCloudProfile.serverUrl, normalized)) {
            const ensuredCloudProfile = canonicalCloudProfile.serverId
                ? { serverId: canonicalCloudProfile.serverId, serverUrl: canonicalCloudProfile.serverUrl }
                : ensureCanonicalCloudRelayProfile();
            if (ensuredCloudProfile) {
                await setActiveServerAndSwitch({ serverId: ensuredCloudProfile.serverId, scope: 'device' });
                return;
            }
        }

        await upsertActivateAndSwitchServer({ serverUrl: normalized, source: 'url', scope: 'device' });
    }, [canonicalCloudProfile, state.context.relaySelection.serverUrl, welcomeRelayUrl]);

    const handleWelcomeLogin = React.useCallback(async () => {
        const relayUrl = welcomeRelayUrl;
        if (relayUrl) {
            setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
        }
        await ensureActiveServerForAuth();
        dispatch({ type: 'wizard/goToStep', stepId: 'auth_restore' });
    }, [ensureActiveServerForAuth, welcomeRelayUrl]);
    const handleOpenRestore = handleWelcomeLogin;

    const handleOpenSetup = React.useCallback(() => {
        router.push('/setup');
    }, []);

    const handleOpenLostAccess = React.useCallback(() => {
        dispatch({ type: 'wizard/goToStep', stepId: 'auth_lost_access' });
    }, []);

    const handleOpenSecretKeyLogin = React.useCallback(() => {
        dispatch({ type: 'wizard/goToStep', stepId: 'auth_secret_key' });
    }, []);

    const handleRelaySelectAdvance = React.useCallback(async () => {
        const isManualRelayEntry =
            state.context.relaySelection.choiceId === 'customUrl'
            && !state.context.relaySelection.relayProfileId
            && !String(state.context.relaySelection.serverUrl ?? '').trim();
        const relayUrl = isManualRelayEntry
            ? null
            : (selectedRelayFooterUrl || snapshotRelayUrl || null);
        setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
        await handleAdvance();
    }, [
        handleAdvance,
        selectedRelayFooterUrl,
        snapshotRelayUrl,
        state.context.relaySelection.choiceId,
        state.context.relaySelection.relayProfileId,
        state.context.relaySelection.serverUrl,
    ]);

    const handleRelayAccessAdvance = React.useCallback(() => {
        setRelaySwitchDecision('switch');
        dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: true });
        dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
    }, [dispatch]);

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
        if (stepId === 'auth_restore' || stepId === 'auth_secret_key' || stepId === 'auth_lost_access') {
            return () => dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
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

    const skipDisabled = activeSkipOverride?.disabled ?? (
        showSkip && stepId === 'welcome'
            ? primaryDisabled
            : false
    );

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
                        : stepId === 'confirm_relay_lock'
                        ? async () => {
                            const relayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
                            if (!relayUrl) {
                                dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
                                return;
                            }
                            const snapshot = getActiveServerSnapshot();
                            if (!isSameServerUrl(snapshot.serverUrl, relayUrl)) {
                                await upsertActivateAndSwitchServer({ serverUrl: relayUrl, source: 'url', scope: 'device' });
                            }
                            dispatch({
                                type: 'wizard/setRelaySelection',
                                relaySelection: {
                                    ...state.context.relaySelection,
                                    serverUrl: relayUrl,
                                    relayProfileId: state.context.relaySelection.relayProfileId ?? null,
                                    locked: true,
                                },
                            });
                            dispatch({ type: 'wizard/setRelayLockConfirmationPending', pending: false });
                            setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
                            dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
                        }
                    : stepId === 'desktop_handoff'
                        ? () => {
                            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'thisComputer', serverUrl: null, relayProfileId: null, locked: false } });
                            dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
                        }
                    : stepId === 'background_service_handoff'
                        ? () => dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' })
                        : stepId === 'host_relay_local'
                        ? async () => {
                            const relayUrlRaw = localRelayRuntimeStatus?.relayUrl ?? '';
                            const relayUrl = relayUrlRaw ? normalizeServerUrl(relayUrlRaw) : null;
                            if (!relayUrl) {
                                return;
                            }
                            setRelaySwitchDecision('switch');
                            dispatch({
                                type: 'wizard/setRelaySelection',
                                relaySelection: {
                                    choiceId: 'thisComputer',
                                    serverUrl: relayUrl,
                                    relayProfileId: state.context.relaySelection.relayProfileId ?? null,
                                    locked: false,
                                },
                            });
                            dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
                        }
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
                                    await upsertActivateAndSwitchServer({ serverUrl: relayUrl, source: 'url', scope: 'device' });
                                    dispatch({
                                        type: 'wizard/setRelaySelection',
                                        relaySelection: {
                                            choiceId: state.context.relaySelection.choiceId ?? 'customUrl',
                                            serverUrl: relayUrl,
                                            relayProfileId: state.context.relaySelection.relayProfileId ?? null,
                                            locked: false,
                                        },
                                    });
                                    setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
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
    const relaySelectBody = renderWizardChoiceList({
        accessibilityLabel: t('setupOnboarding.preAuthTitle'),
        items: [
            ...profileChoices.map(buildRelayChoiceItem),
            ...relayChoices.map(buildRelayChoiceItem),
            buildManualRelayChoiceItem(),
        ],
    });
    body = renderOnboardingWizardStepBody({
        stepId,
        testIDPrefix: props.testID ?? 'onboarding-wizard',
        styles,
        theme,
        layout: props.layout,
        isDesktopShell: props.isDesktopShell,
        authEntryOptions: props.authEntryOptions,
        canScanQr,
        welcomeHasKnownRelay,
        welcomeHasAuthActions,
        allowRelaySelection: setupPolicy.relay.allowRelaySelection,
        relaySelectBody,
        urlDraft,
        onUrlDraftChange: setUrlDraft,
        relaySelectionServerUrl,
        confirmRelayUrl,
        serverProfileId: state.context.relaySelection.relayProfileId ?? null,
        relayAccessTarget: relayAccessTarget ?? defaultRelayAccessTarget,
        lastKnownSnapshotRelayUrl: lastKnownSnapshotRelayUrlRef.current || '',
        reachabilityRemediation: activeReachabilityRemediation,
        reachabilityRemediationTaskSnapshot: tailscaleEnsureReadySnapshot,
        reachabilityRemediationError,
        onReachabilityRemediationAction: handleReachabilityRemediationAction,
        onRelayAccessShareUrlChange: handleRelayAccessShareUrlChange,
        relaySwitchDecision,
        onRelaySwitchDecisionChange: setRelaySwitchDecision,
        onLocalRelayRuntimeStatusChange: handleLocalRelayRuntimeStatusChange,
        onWizardPrimaryChange: handleWizardPrimaryChange,
        onWizardBackChange: handleWizardBackChange,
        onWizardSkipChange: handleWizardSkipChange,
        relayAccessProviderId: state.context.relayAccessProviderId,
        onRelayAccessProviderIdChange: handleRelayAccessProviderIdChange,
        onRelayAccessProviderDetailsRequested: handleRelayAccessProviderDetailsRequested,
        onCreateAccount: async () => {
            await ensureActiveServerForAuth();
            await props.onCreateAccount();
        },
        onCreateAccountViaProvider: async (providerId: string) => {
            await ensureActiveServerForAuth();
            await props.onCreateAccountViaProvider(providerId);
        },
        onLoginWithKeylessProvider: async (providerId: string) => {
            await ensureActiveServerForAuth();
            await props.onLoginWithKeylessProvider(providerId);
        },
        onLoginWithMtls: async () => {
            await ensureActiveServerForAuth();
            await props.onLoginWithMtls();
        },
        onStartScan: () => {
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: true });
            dispatch({ type: 'wizard/goToStep', stepId: 'scan_code' });
        },
        onCancelScan: () => {
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'welcome' });
        },
        onScan: handleScan,
        onOpenRelaySelectionFromWelcome: handleOpenRelaySelectionFromWelcome,
        onOpenRelaySelectionFromAuth: handleOpenRelaySelectionPreservingSelection,
        onOpenSetup: handleOpenSetup,
        onOpenRestore: handleOpenRestore,
        onOpenLostAccess: handleOpenLostAccess,
        onOpenSecretKeyLogin: handleOpenSecretKeyLogin,
        onRestoreBackToAuth: () => dispatch({ type: 'wizard/back' }),
        onLostAccessBackToAuth: () => dispatch({ type: 'wizard/back' }),
        onHostRelayLocalAdvance: () => dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' }),
        onRelayAccessAdvance: handleRelayAccessAdvance,
        onHostRelayRemoteAdvance: () => dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' }),
        onHostRelayRemoteCancel: () => dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' }),
        onRemoteRelayRuntimeCompleted: handleRemoteRelayRuntimeCompletedChange,
    });

    const resolvedOnBack = onBack ?? null;

    return {
        stepId,
        currentStepIndex,
        stepCount: Math.max(1, progress.total),
        contentTransitionDirection,
        showBack: Boolean(resolvedOnBack),
        showSkip: activeSkipOverride ? !activeSkipOverride.hidden : undefined,
        onBack: resolvedOnBack,
        onSkip: onSkip ?? null,
        onPrimary: onPrimary ?? null,
        primaryLabel: activePrimaryOverride?.label ?? primaryLabel,
        primaryDisabled: activePrimaryOverride?.disabled ?? primaryDisabled,
        skipLabel: activeSkipOverride?.label ?? skipLabel,
        skipDisabled,
        title,
        subtitle,
        footerHint,
        body,
        goToStep: (nextStepId: WizardStepId) => {
            dispatch({ type: 'wizard/goToStep', stepId: nextStepId });
        },
    };
}
