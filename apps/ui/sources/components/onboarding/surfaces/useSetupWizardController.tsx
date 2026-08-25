import * as React from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { type SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { Text } from '@/components/ui/text/Text';
import { ActiveRelaySummary } from '@/components/onboarding/ui/ActiveRelaySummary';
import {
    resolveStepTransitionDirection,
    type StepTransitionDirection,
} from '@/components/ui/motion/StepTransitionFrame';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useAllSessions, useMachine } from '@/sync/store/hooks';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { t, tLoose } from '@/text';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { readServerReachabilityProbeTimeoutMs } from '@/sync/runtime/connectivity/serverReachabilityTuning';
import { useEndpointReachabilityRemediationController } from '@/components/settings/server/hooks/useEndpointReachabilityRemediationController';
import {
    getEndpointReachabilityProvider,
    resolveEndpointReachabilityRemediation,
    type EndpointReachabilityRemediation,
} from '@/components/serverReachability/remediation';
import { getAgentCliSetupSupportedIds, type AgentId } from '@happier-dev/agents';
import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { createWizardState, wizardReducer } from '../state/wizardReducer';
import { canSkipWizardStep, getWizardProgress } from '../state/wizardSelectors';
import type { WizardContext, WizardState, WizardStepId } from '../state/wizardTypes';
import { type RelaySwitchDecision } from '../steps/ConfirmSwitchRelayStep';
import { getWizardStepDefinition, wizardStepRegistry } from '../state/wizardStepRegistry';
import { resolveWizardAdvance, type WizardAdvanceResolution } from '../state/wizardAdvance';
import { SetupThisComputerWizardStep } from '../steps/SetupThisComputerWizardStep';
import { RelayHostLocalChecklistStep } from '../checklists/relayHostLocal/RelayHostLocalChecklistStep';
import type { RelayHostLocalChecklistRuntimeStatus } from '../checklists/relayHostLocal/types';
import { useWizardChromeOverrides } from '../hooks/useWizardChromeOverrides';
import { useEndpointReadinessMap } from '../hooks/useEndpointReadinessMap';
import { renderSetupStepBody } from './SetupWizardSurface.renderSetupStepBody';
import { resolveRelaySwitchUrl } from './relaySelection/relaySelectionHelpers';
import { usePendingSetupIntent } from '../state/usePendingSetupIntent';
import { renderWizardChoiceList } from './WizardChoiceList';
import { useProviderReadiness } from '../detection/useProviderReadiness';
import { resolveWizardCapabilities } from '../capabilities/resolveWizardCapabilities';

export type SetupWizardSurfaceProps = Readonly<{
    testID?: string;
    isDesktopShell: boolean;
    useOuterScrollContainer?: boolean;
    onExit?: () => void;
    initialSetupAction?: WizardContext['setupAction'];
    initialStepId?: WizardStepId;
    scope?: 'all' | 'relay' | 'machine';
}>;

type SetupAction = WizardContext['setupAction'];
type SetupChooserAction = 'local' | 'relayLocal' | 'remote';
export type RemoteSetupIntent = 'remoteMachine' | 'remoteRelayHost';

const stylesheet = StyleSheet.create((theme) => ({
    branchList: {
        width: '100%',
        gap: 6,
    },
    urlBlock: {
        width: '100%',
        gap: 10,
    },
    urlInput: {
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        color: theme.colors.text.primary,
    },
    urlHint: {
        color: theme.colors.text.secondary,
        textAlign: 'left',
    },
    branchHint: {
        color: theme.colors.text.secondary,
        textAlign: 'left',
    },
    doneLine: {
        color: theme.colors.text.secondary,
        textAlign: 'left',
    },
    doneSummary: {
        color: theme.colors.text.primary,
        textAlign: 'left',
    },
    webRelayHostHandoff: {
        width: '100%',
        gap: 16,
    },
}));

export type SetupWizardSurfaceStyles = typeof stylesheet;

export type RemoteRelayRuntimeCompletion = Readonly<{
    machineId: string | null;
    relayRuntimeUrl: string | null;
    relayAccessTarget: RelayAccessTaskTarget | null;
    mode: RemoteSetupIntent;
}>;

export type SetupWizardController = Readonly<{
    stepId: WizardStepId;
    currentStepIndex: number;
    stepCount: number;
    contentTransitionKey: WizardStepId;
    contentTransitionDirection: StepTransitionDirection;
    title: string;
    subtitle: string | null;
    scrollable: boolean;
    body: React.ReactNode;
    onPrimary: (() => void | Promise<void>) | undefined;
    primaryLabel: React.ReactNode;
    primaryDisabled: boolean;
    onBack: (() => void | Promise<void>) | undefined;
    backLabel: React.ReactNode;
    showBack: boolean;
    onSkip: (() => void | Promise<void>) | undefined;
    skipLabel: React.ReactNode;
    skipDisabled: boolean | undefined;
    showSkip: boolean;
    footerHint: React.ReactNode | null;
    goToStep: (stepId: WizardStepId) => void;
}>;

export function useSetupWizardController(props: SetupWizardSurfaceProps): SetupWizardController {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const scope = props.scope ?? 'all';
    const setupPolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const wizardPlatform = props.isDesktopShell ? 'desktop' : (Platform.OS === 'web' ? 'web' : 'native');
    const wizardCapabilities = React.useMemo(() => resolveWizardCapabilities({
        platform: wizardPlatform,
        isDesktopShell: props.isDesktopShell,
    }), [props.isDesktopShell, wizardPlatform]);
    const activeServerSnapshot = useActiveServerSnapshot();
    // Keep a stable testID prefix for internal wizard controls, regardless of the outer container testID.
    // The route uses `testID="setupWizard.surface"` for the shell; child controls should remain addressable
    // via `setupWizard-*` for unit and Playwright tests.
    const testIDPrefix = 'setupWizard';
    const relayDriftBanner = useRelayDriftBanner();
    const activeRelayUrlRaw = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
    const footerHint = activeRelayUrlRaw
        ? <ActiveRelaySummary relayUrl={activeRelayUrlRaw} status="active" idPrefix={`${testIDPrefix}-relay-hint`} />
        : null;
    const pendingSetupIntent = usePendingSetupIntent();
    const initialPendingSetupIntentRef = React.useRef(pendingSetupIntent);
    const initialPendingSetupIntent = initialPendingSetupIntentRef.current;
    const resumeFromPending =
        initialPendingSetupIntent?.phase === 'awaiting_auth'
        || initialPendingSetupIntent?.phase === 'post_auth';
    const resolvedInitialStepId: WizardStepId = resumeFromPending
        ? initialPendingSetupIntent?.branch === 'remoteMachine'
            ? 'remote_ssh_setup'
            : 'setup_this_computer'
        : 'setup_chooser';
    const resolvedInitialSetupAction: SetupAction = resumeFromPending
        ? initialPendingSetupIntent?.branch === 'remoteMachine'
            ? 'remote'
            : 'local'
        : null;
    const initialSetupActionFromStep: SetupAction = React.useMemo(() => {
        switch (props.initialStepId) {
            case 'setup_this_computer':
                return 'local';
            case 'host_relay_local':
                return 'relayLocal';
            case 'remote_ssh_setup':
                return 'remote';
            default:
                return null;
        }
    }, [props.initialStepId]);
    const initialSetupAction: SetupAction = initialSetupActionFromStep ?? props.initialSetupAction ?? resolvedInitialSetupAction;
    const initialStepId: WizardStepId = props.initialStepId ?? resolvedInitialStepId;
    const initialRemoteIntent: RemoteSetupIntent = resumeFromPending && initialPendingSetupIntent?.branch === 'remoteMachine'
        ? (initialPendingSetupIntent.remoteSetupIntent ?? 'remoteMachine')
        : 'remoteMachine';
    const initialStepIdRef = React.useRef<WizardStepId>(initialStepId);

    const exitWizard = React.useCallback(() => {
        props.onExit?.();
        if (!props.onExit) {
            router.replace('/setup');
        }
    }, [props.onExit]);

    const [state, dispatch] = React.useReducer(
        wizardReducer,
        null,
        () =>
            createWizardState({
                context: {
                    mode: 'setup',
                    platform: wizardPlatform,
                    canScanQr: false,
                    scanStepEnabled: false,
                    canRunSystemTasks: props.isDesktopShell,
                    relaySelection: { choiceId: null, serverUrl: null, locked: false },
                    relayAccessProviderId: null,
                    relayLockConfirmationPending: false,
                    relaySwitchConfirmationPending: false,
                    authIntent: 'standard',
                    setupAction: initialSetupAction,
                },
                currentStepId: initialStepId,
                history: [],
                resumeState: null,
                parsedScanPayload: null,
            }),
    );

    const stepId = state.currentStepId;
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
    const action = state.context.setupAction;
    const relayCandidateUrl = state.context.relaySelection.serverUrl;
    const showSkip = canSkipWizardStep(state.context, stepId);
    const stepDefinition = getWizardStepDefinition(stepId);
    const title = tLoose(stepDefinition.titleKey);
    const subtitle = stepDefinition.subtitleKey ? tLoose(stepDefinition.subtitleKey) : null;

    const [relaySwitchDecision, setRelaySwitchDecision] = React.useState<RelaySwitchDecision>('keep');
    const [pendingRelayRuntime, setPendingRelayRuntime] = React.useState<Readonly<{
        relayUrl: string;
        machineId: string | null;
    }> | null>(null);
    const [relayAccessTarget, setRelayAccessTarget] = React.useState<RelayAccessTaskTarget | null>(null);
    const [relayAccessShareUrl, setRelayAccessShareUrl] = React.useState<string | null>(null);
    const [localRelayRuntimeStatus, setLocalRelayRuntimeStatus] = React.useState<RelayHostLocalChecklistRuntimeStatus | null>(null);
    const defaultRelayAccessTarget = React.useMemo<RelayAccessTaskTarget>(() => ({ kind: 'local' }), []);
    const [localMachineId, setLocalMachineId] = React.useState<string | null>(null);
    const [remoteMachineId, setRemoteMachineId] = React.useState<string | null>(null);
    const [remoteSetupIntent, setRemoteSetupIntent] = React.useState<RemoteSetupIntent>(initialRemoteIntent);
    const [webRelayHostUrlDraft, setWebRelayHostUrlDraft] = React.useState('');
    const [webRemoteSshDraft, setWebRemoteSshDraft] = React.useState<SshCredentialsDraft>(() => ({
        username: '',
        host: '',
        port: '',
        authMode: 'agent',
        identityFilePath: '',
        password: '',
    }));
    const [machineArrivalSince, setMachineArrivalSince] = React.useState<number | null>(null);
    const providerSelectionProviderIds = React.useMemo(() => getAgentCliSetupSupportedIds(), []);
    const [selectedAgentIds, setSelectedProviderIds] = React.useState<AgentId[]>([]);
    const providerMachineId = action === 'remote' ? remoteMachineId : localMachineId;
    const connectedMachineId = React.useMemo(() => (
        remoteMachineId
        ?? localMachineId
        ?? (initialPendingSetupIntent?.branch === 'remoteMachine' ? initialPendingSetupIntent.machineId : null)
        ?? null
    ), [initialPendingSetupIntent, localMachineId, remoteMachineId]);
    const connectedMachine = useMachine(connectedMachineId ?? '');
    const connectedMachineLabel = React.useMemo(() => {
        const host = (connectedMachine as { metadata?: { host?: unknown } } | null)?.metadata?.host;
        if (typeof host === 'string' && host.trim().length > 0) return host.trim();
        return connectedMachineId;
    }, [connectedMachine, connectedMachineId]);
    const existingSessionCount = useAllSessions().filter(isUserFacingSession).length;
    const providerReadiness = useProviderReadiness({
        machineId: stepId === 'providers_optional' ? providerMachineId : null,
        providerIds: providerSelectionProviderIds,
        serverId: activeServerSnapshot.serverId ? String(activeServerSnapshot.serverId) : null,
    });
    const {
        activePrimaryOverride: primaryOverride,
        activeBackOverride: backOverride,
        activeSkipOverride: skipOverride,
        setWizardPrimaryOverride: handleWizardPrimaryChange,
        setWizardBackOverride: handleWizardBackChange,
        setWizardSkipOverride: handleWizardSkipChange,
    } = useWizardChromeOverrides(stepId, { resetOnStepChange: true });

    const persistRemoteSetupIntent = React.useCallback((nextRemoteSetupIntent: RemoteSetupIntent, relayUrl: string | null, machineId: string | null) => {
        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: relayUrl ? String(relayUrl).trim() : (activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : null),
            machineId,
            remoteSetupIntent: nextRemoteSetupIntent,
        });
    }, [activeServerSnapshot.serverUrl]);

    const onToggleAgentId = React.useCallback((providerId: AgentId) => {
        setSelectedProviderIds((current) => (
            current.includes(providerId)
                ? current.filter((id) => id !== providerId)
                : [...current, providerId]
        ));
    }, []);

    const handleLocalSetupSucceeded = React.useCallback((machineId: string | null) => {
        const normalized = typeof machineId === 'string' && machineId.trim().length > 0 ? machineId.trim() : null;
        setLocalMachineId((current) => current === normalized ? current : normalized);
    }, []);
    const previousLocalMachineIdRef = React.useRef<string | null>(localMachineId);

    React.useEffect(() => {
        if (stepId !== 'setup_this_computer' || state.context.platform === 'desktop') {
            return;
        }
        setMachineArrivalSince(Date.now());
    }, [state.context.platform, stepId]);

    React.useEffect(() => {
        const previousLocalMachineId = previousLocalMachineIdRef.current;
        previousLocalMachineIdRef.current = localMachineId;

        if (
            stepId !== 'setup_this_computer'
            || state.context.platform === 'desktop'
            || previousLocalMachineId !== null
            || localMachineId === null
        ) {
            return;
        }

        dispatch({ type: 'wizard/goToStep', stepId: 'providers_optional' });
    }, [localMachineId, state.context.platform, stepId]);

    const handleMachineArrived = React.useCallback((machine: Machine) => {
        handleLocalSetupSucceeded(machine.id);
    }, [handleLocalSetupSucceeded]);

    const handleLocalSetupNeedsAuth = React.useCallback(() => {
        const relayUrl = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
        if (!relayUrl) {
            return;
        }
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl,
        });
        router.push(`/server?url=${encodeURIComponent(relayUrl)}&auto=1`);
    }, [activeServerSnapshot.serverUrl]);

    const clearRelayRuntimeCandidate = React.useCallback(() => {
        setRelaySwitchDecision('keep');
        setPendingRelayRuntime(null);
        setLocalRelayRuntimeStatus(null);
        setRelayAccessTarget(null);
        setRelayAccessShareUrl(null);
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: { choiceId: null, serverUrl: null, locked: false },
        });
    }, []);

    const setRelayRuntimeCandidate = React.useCallback((
        relayUrl: string | null,
        machineId: string | null,
        nextRelayAccessTarget: RelayAccessTaskTarget | null,
    ) => {
        const normalized = String(relayUrl ?? '').trim();
        if (!normalized) {
            clearRelayRuntimeCandidate();
            return;
        }
        const profile = upsertServerProfileOnly({
            serverUrl: normalized,
            source: 'url',
        });
        setPendingRelayRuntime({ relayUrl: normalized, machineId });
        setRelayAccessTarget(nextRelayAccessTarget);
        setRelayAccessShareUrl(null);
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: {
                choiceId: 'customUrl',
                serverUrl: normalized,
                relayProfileId: profile.id,
                locked: true,
            },
        });
    }, [clearRelayRuntimeCandidate]);

    const effectiveRelayCandidateUrl = React.useMemo(() => resolveRelaySwitchUrl({
        relayRuntimeUrl: relayCandidateUrl,
        relayAccessShareUrl,
        relayAccessTarget,
    }), [relayAccessShareUrl, relayAccessTarget, relayCandidateUrl]);
    const confirmSwitchRelayEndpointForReadiness = React.useMemo(() => {
        if (stepId !== 'confirm_switch_relay' || relaySwitchDecision !== 'switch') {
            return null;
        }
        const relayUrl = typeof effectiveRelayCandidateUrl === 'string' ? effectiveRelayCandidateUrl.trim() : '';
        return relayUrl.length > 0 ? relayUrl : null;
    }, [effectiveRelayCandidateUrl, relaySwitchDecision, stepId]);
    const webRelayHostEndpointForReadiness = React.useMemo(() => {
        if (stepId !== 'host_relay_local' || state.context.platform === 'desktop') {
            return null;
        }
        const normalized = normalizeServerUrl(webRelayHostUrlDraft);
        return normalized ? normalized : null;
    }, [state.context.platform, stepId, webRelayHostUrlDraft]);
    const readinessEndpoints = React.useMemo(() => [
        ...(confirmSwitchRelayEndpointForReadiness ? [confirmSwitchRelayEndpointForReadiness] : []),
        ...(webRelayHostEndpointForReadiness ? [webRelayHostEndpointForReadiness] : []),
    ], [confirmSwitchRelayEndpointForReadiness, webRelayHostEndpointForReadiness]);
    const { readinessByEndpoint: relayReadinessByEndpoint, retryEndpoint } = useEndpointReadinessMap({
        endpoints: readinessEndpoints,
        enabled: stepId === 'confirm_switch_relay' || stepId === 'host_relay_local',
        timeoutMs: readServerReachabilityProbeTimeoutMs(),
    });
    const activeReachabilityRemediation = React.useMemo<EndpointReachabilityRemediation | null>(() => {
        if (!confirmSwitchRelayEndpointForReadiness) {
            return null;
        }
        const readiness = relayReadinessByEndpoint.get(confirmSwitchRelayEndpointForReadiness);
        if (!readiness?.probeResult || readiness.probeResult.status === 'ready') {
            return null;
        }
        return resolveEndpointReachabilityRemediation({
            endpointUrl: confirmSwitchRelayEndpointForReadiness,
            readiness: readiness.probeResult,
            platformOs: Platform.OS,
            isDesktopShell: props.isDesktopShell,
        });
    }, [confirmSwitchRelayEndpointForReadiness, props.isDesktopShell, relayReadinessByEndpoint]);
    const webRelayHostReachabilityRemediation = React.useMemo<EndpointReachabilityRemediation | null>(() => {
        if (!webRelayHostEndpointForReadiness) {
            return null;
        }
        const readiness = relayReadinessByEndpoint.get(webRelayHostEndpointForReadiness);
        if (!readiness?.probeResult || readiness.probeResult.status === 'ready') {
            return null;
        }
        return resolveEndpointReachabilityRemediation({
            endpointUrl: webRelayHostEndpointForReadiness,
            readiness: readiness.probeResult,
            platformOs: Platform.OS,
            isDesktopShell: props.isDesktopShell,
        });
    }, [props.isDesktopShell, relayReadinessByEndpoint, webRelayHostEndpointForReadiness]);
    const webRelayHostReadiness = webRelayHostEndpointForReadiness
        ? relayReadinessByEndpoint.get(webRelayHostEndpointForReadiness)
        : null;
    const isWebRelayHostUrlInvalid = stepId === 'host_relay_local'
        && state.context.platform !== 'desktop'
        && webRelayHostUrlDraft.trim().length > 0
        && webRelayHostEndpointForReadiness == null;
    const isWebRelayHostReadinessPending = stepId === 'host_relay_local'
        && state.context.platform !== 'desktop'
        && webRelayHostEndpointForReadiness != null
        && (webRelayHostReadiness == null || webRelayHostReadiness.status === 'checking');
    const isWebRelayHostUnavailable = stepId === 'host_relay_local'
        && state.context.platform !== 'desktop'
        && webRelayHostEndpointForReadiness != null
        && webRelayHostReadiness?.probeResult != null
        && webRelayHostReadiness.probeResult.status !== 'ready';
    const isActiveReachabilityRemediationPending = React.useMemo(() => {
        if (!confirmSwitchRelayEndpointForReadiness) {
            return false;
        }
        if (getEndpointReachabilityProvider(confirmSwitchRelayEndpointForReadiness) !== 'tailscale') {
            return false;
        }
        const readiness = relayReadinessByEndpoint.get(confirmSwitchRelayEndpointForReadiness);
        return readiness == null || readiness.status === 'checking';
    }, [confirmSwitchRelayEndpointForReadiness, relayReadinessByEndpoint]);
    const currentReachabilityRemediation = activeReachabilityRemediation ?? webRelayHostReachabilityRemediation;
    const currentReachabilityEndpoint = activeReachabilityRemediation
        ? confirmSwitchRelayEndpointForReadiness
        : webRelayHostReachabilityRemediation
            ? webRelayHostEndpointForReadiness
            : null;
    const {
        error: reachabilityRemediationError,
        taskSnapshot: tailscaleEnsureReadySnapshot,
        onAction: handleReachabilityRemediationAction,
    } = useEndpointReachabilityRemediationController({
        remediation: currentReachabilityRemediation,
        endpoint: currentReachabilityEndpoint,
        onRetryEndpoint: retryEndpoint,
    });

    const onSkip = React.useCallback(() => {
        exitWizard();
    }, [exitWizard]);

    const onBack = React.useCallback(() => {
        if (resumeFromPending && stepId === initialStepIdRef.current) {
            exitWizard();
            return;
        }
        if (stepId === 'setup_chooser') {
            exitWizard();
            return;
        }
        dispatch({ type: 'wizard/back' });
    }, [exitWizard, resumeFromPending, stepId]);

    const chooseAction = React.useCallback((nextAction: SetupChooserAction) => {
        clearRelayRuntimeCandidate();
        if (nextAction !== 'local') {
            setLocalMachineId(null);
        }
        setRemoteMachineId(null);
        setRemoteSetupIntent('remoteMachine');
        dispatch({ type: 'wizard/setSetupAction', setupAction: nextAction });
    }, [clearRelayRuntimeCandidate]);

    const chooseRemoteMachineSetup = React.useCallback(() => {
        clearRelayRuntimeCandidate();
        setLocalMachineId(null);
        setRemoteMachineId(null);
        setRemoteSetupIntent('remoteMachine');
        persistRemoteSetupIntent('remoteMachine', null, null);
        dispatch({ type: 'wizard/setSetupAction', setupAction: 'remote' });
    }, [clearRelayRuntimeCandidate, persistRemoteSetupIntent]);

    const chooseRemoteRelayHost = React.useCallback(() => {
        clearRelayRuntimeCandidate();
        setLocalMachineId(null);
        setRemoteMachineId(null);
        setRemoteSetupIntent('remoteRelayHost');
        persistRemoteSetupIntent('remoteRelayHost', null, null);
        dispatch({ type: 'wizard/setSetupAction', setupAction: 'remote' });
    }, [clearRelayRuntimeCandidate, persistRemoteSetupIntent]);

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
                    break;
                case 'setRelaySelection':
                    dispatch({
                        type: 'wizard/setRelaySelection',
                        relaySelection: effect.relaySelection,
                    });
                    break;
                case 'persistOnboardingIntent':
                    break;
                case 'clearRelayAccessDraft':
                    setRelayAccessTarget(null);
                    setRelayAccessShareUrl(null);
                    break;
                case 'setRelayRuntimeCandidate':
                    setRelayRuntimeCandidate(effect.relayUrl, effect.machineId, effect.relayAccessTarget);
                    break;
                case 'setPendingSetupIntent':
                    setPendingSetupIntent(effect.intent);
                    break;
                case 'exitSetup':
                    props.onExit?.();
                    break;
                case 'navigate':
                    router.replace(effect.route);
                    break;
            }
        }

        if (resolution.nextStepId) {
            dispatch({ type: 'wizard/goToStep', stepId: resolution.nextStepId });
        }
    }, [props.onExit, setRelayRuntimeCandidate]);

    const resolveSetupPrimaryAdvance = React.useCallback((relayRuntimeUrlOverride?: string | null): WizardAdvanceResolution => {
        const resolutionState: WizardState = typeof relayRuntimeUrlOverride === 'string'
            ? {
                ...state,
                context: {
                    ...state.context,
                    relaySelection: {
                        ...state.context.relaySelection,
                        serverUrl: relayRuntimeUrlOverride,
                    },
                },
            }
            : state;

        return resolveWizardAdvance(resolutionState, wizardStepRegistry, {
            type: 'primary',
            allowProviderSetup: setupPolicy.providers.allowProviderSetup,
            activeServerUrl: activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : null,
            relaySwitchDecision,
            effectiveRelayCandidateUrl,
            pendingRelayMachineId: pendingRelayRuntime?.machineId ?? null,
            remoteSetupIntent,
        });
    }, [activeServerSnapshot.serverUrl, effectiveRelayCandidateUrl, pendingRelayRuntime?.machineId, relaySwitchDecision, remoteSetupIntent, setupPolicy.providers.allowProviderSetup, state]);

    const onPrimary = React.useCallback(async () => {
        await applyWizardAdvanceResolution(resolveSetupPrimaryAdvance());
    }, [applyWizardAdvanceResolution, resolveSetupPrimaryAdvance]);

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

    const handleLocalRelayStatusChange = React.useCallback((status: unknown) => {
        const nextStatus = status as RelayHostLocalChecklistRuntimeStatus | null;
        setLocalRelayRuntimeStatus(nextStatus);
        const relayUrl = (nextStatus as { relayUrl?: unknown } | null | undefined)?.relayUrl;
        setRelayRuntimeCandidate(typeof relayUrl === 'string' ? relayUrl : null, null, { kind: 'local' });
    }, [setRelayRuntimeCandidate]);

    const handleRemoteRelayRuntimeCompletedChange = React.useCallback((payload: RemoteRelayRuntimeCompletion) => {
        setRemoteMachineId(payload.machineId);
        const relayUrl = typeof payload.relayRuntimeUrl === 'string' ? payload.relayRuntimeUrl.trim() : '';
        if (relayUrl.length > 0) {
            if (payload.mode === 'remoteRelayHost') {
                setRelaySwitchDecision('switch');
            }
            setRelayRuntimeCandidate(relayUrl, payload.machineId, payload.relayAccessTarget);
            persistRemoteSetupIntent('remoteRelayHost', relayUrl, payload.machineId);
        }
    }, [persistRemoteSetupIntent, setRelayRuntimeCandidate]);

    const handleRelayUrlPasteChange = React.useCallback((value: string) => {
        setWebRelayHostUrlDraft(value);
        const normalized = normalizeServerUrl(value);
        if (!normalized) {
            clearRelayRuntimeCandidate();
            return;
        }
        setRelayRuntimeCandidate(normalized, null, { kind: 'local' });
    }, [clearRelayRuntimeCandidate, setRelayRuntimeCandidate]);

    const handleRelayShareUrlPasteChange = React.useCallback((value: string) => {
        setRelayRuntimeCandidate(value, null, relayAccessTarget ?? defaultRelayAccessTarget);
    }, [defaultRelayAccessTarget, relayAccessTarget, setRelayRuntimeCandidate]);

    const handleRelayAccessShareUrlChange = React.useCallback((shareUrl: string | null) => {
        const normalized = typeof shareUrl === 'string' ? shareUrl.trim() : '';
        setRelayAccessShareUrl(normalized || null);
    }, []);

    const handleRequestAdvance = React.useCallback(() => {
        void onPrimary();
    }, [onPrimary]);

    const handleLocalRelayPrimary = React.useCallback(() => {
        void applyWizardAdvanceResolution(resolveSetupPrimaryAdvance(
            typeof localRelayRuntimeStatus?.relayUrl === 'string' ? localRelayRuntimeStatus.relayUrl : '',
        ));
    }, [applyWizardAdvanceResolution, localRelayRuntimeStatus?.relayUrl, resolveSetupPrimaryAdvance]);

    const handleLocalRelayRequestAdvance = React.useCallback((status: RelayHostLocalChecklistRuntimeStatus | null) => {
        if (stepId === 'host_relay_local') {
            void applyWizardAdvanceResolution(resolveSetupPrimaryAdvance(
                typeof status?.relayUrl === 'string' ? status.relayUrl : '',
            ));
            return;
        }

        void onPrimary();
    }, [applyWizardAdvanceResolution, onPrimary, resolveSetupPrimaryAdvance, stepId]);

    const localRelayRuntimeSatisfied = localRelayRuntimeStatus?.installed === true
        && localRelayRuntimeStatus?.service.active === true
        && localRelayRuntimeStatus?.healthy === true;

    const handleStartFirstSession = React.useCallback(() => {
        const draftId = resolveNewSessionDraftRouteIdentity({ routeDraftId: undefined }).draftId;
        router.push({
            pathname: '/new',
            params: buildNewSessionLaunchRouteParams({
                draftId,
                machineId: connectedMachineId,
                targetServerId: activeServerSnapshot.serverId ? String(activeServerSnapshot.serverId) : null,
            }),
        });
    }, [activeServerSnapshot.serverId, connectedMachineId]);

    let body: React.ReactNode = null;
    if (stepId === 'setup_chooser') {
        const showLocalMachine = scope !== 'relay' && setupPolicy.machine.allowLocalMachineSetup;
        const showRemoteMachine = scope !== 'relay'
            && setupPolicy.machine.allowRemoteSshMachineSetup
            && (state.context.platform !== 'native' || wizardCapabilities.allowNativeSshMachineSetup);
        const showRelayHosting = scope !== 'machine' && setupPolicy.relay.allowLocalRelayHost;
        const showRemoteRelayHosting = scope !== 'machine' && setupPolicy.relay.allowRemoteSshRelayHost;

        body = (
            <>
                {relayDriftBanner ? <RelayDriftActionCard banner={relayDriftBanner} /> : null}
                {renderWizardChoiceList({
                    accessibilityLabel: t('setupOnboarding.screenTitle'),
                    style: styles.branchList,
                    items: [
                        showLocalMachine && {
                            itemKey: 'local',
                            testID: `${testIDPrefix}-branch:local`,
                            selected: action === 'local',
                            onPress: () => chooseAction('local'),
                            icon: 'laptop',
                            title: t('settings.machineSetupCurrentMachineTitle'),
                            subtitle: t('settings.machineSetupCurrentMachineSubtitle'),
                        },
                        showRelayHosting && {
                            itemKey: 'relayLocal',
                            testID: `${testIDPrefix}-branch:relayLocal`,
                            selected: action === 'relayLocal',
                            onPress: () => chooseAction('relayLocal'),
                            icon: 'cloud-arrow-up',
                            title: t('setupOnboarding.relayOnThisComputerTitle'),
                            subtitle: t('setupOnboarding.relayOnThisComputerSubtitle'),
                        },
                        showRemoteMachine && {
                            itemKey: 'remote',
                            testID: `${testIDPrefix}-branch:remote`,
                            selected: action === 'remote' && remoteSetupIntent === 'remoteMachine',
                            onPress: chooseRemoteMachineSetup,
                            icon: 'hard-drives',
                            title: t('settings.machineSetupSshMachineTitle'),
                            subtitle: t('settings.machineSetupSshMachineSubtitle'),
                        },
                        showRemoteRelayHosting && {
                            itemKey: 'remoteRelay',
                            testID: `${testIDPrefix}-branch:remoteRelay`,
                            selected: action === 'remote' && remoteSetupIntent === 'remoteRelayHost',
                            onPress: chooseRemoteRelayHost,
                            icon: 'cloud-arrow-up',
                            title: t('setupOnboarding.relayOnRemoteComputerTitle'),
                            subtitle: t('setupOnboarding.relayOnRemoteComputerSubtitle'),
                        },
                    ],
                })}
                <Text style={styles.branchHint}>{t('setupOnboarding.postAuthBody')}</Text>
            </>
        );
    } else {
        if (stepId === 'setup_this_computer' && props.isDesktopShell) {
            body = (
                <SetupThisComputerWizardStep
                    testID="setupWizard-setup-this-computer"
                    onSucceeded={handleLocalSetupSucceeded}
                    onNeedsAuth={handleLocalSetupNeedsAuth}
                    onWizardPrimaryChange={handleWizardPrimaryChange}
                    onRequestAdvance={() => dispatch({ type: 'wizard/goToStep', stepId: 'providers_optional' })}
                />
            );
        } else if (stepId === 'host_relay_local' && props.isDesktopShell) {
            body = (
                <RelayHostLocalChecklistStep
                    testID="setupWizard-relay-host-local"
                    onStatusChange={handleLocalRelayStatusChange}
                    onWizardPrimaryChange={handleWizardPrimaryChange}
                    onRequestAdvance={handleLocalRelayRequestAdvance}
                />
            );
        } else {
            body = renderSetupStepBody({
                theme,
                styles,
                stepId,
                testIDPrefix,
                platform: state.context.platform,
                isDesktopShell: props.isDesktopShell,
                remoteSetupIntent,
                allowNativeSshMachineSetup: wizardCapabilities.allowNativeSshMachineSetup,
                webRemoteSshDraft,
                onWebRemoteSshDraftChange: setWebRemoteSshDraft,
                activeServerUrl: activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : null,
                activeLocalRelayUrl: activeServerSnapshot.activeLocalRelayUrl
                    ? String(activeServerSnapshot.activeLocalRelayUrl).trim()
                    : null,
                relayUrl: relayCandidateUrl,
                webRelayHostUrlDraft,
                webRelayHostInvalidUrl: isWebRelayHostUrlInvalid,
                confirmRelayUrl: effectiveRelayCandidateUrl,
                serverProfileId: state.context.relaySelection.relayProfileId ?? null,
                relayAccessTarget: relayAccessTarget ?? defaultRelayAccessTarget,
                reachabilityRemediation: activeReachabilityRemediation,
                webRelayHostReachabilityRemediation,
                reachabilityRemediationTaskSnapshot: tailscaleEnsureReadySnapshot,
                reachabilityRemediationError,
                onReachabilityRemediationAction: handleReachabilityRemediationAction,
                machineArrivalSince,
                onMachineArrived: handleMachineArrived,
                providerMachineId,
                providerSelectionProviderIds,
                selectedAgentIds,
                providerReadiness,
                onToggleAgentId,
                onLocalSetupSucceeded: handleLocalSetupSucceeded,
                onLocalSetupNeedsAuth: handleLocalSetupNeedsAuth,
                relaySwitchDecision,
                onRelaySwitchDecisionChange: setRelaySwitchDecision,
                onLocalRelayStatusChange: handleLocalRelayStatusChange,
                onRemoteRelayRuntimeCompletedChange: handleRemoteRelayRuntimeCompletedChange,
                onRelayUrlPasteChange: handleRelayUrlPasteChange,
                onRelayShareUrlPasteChange: handleRelayShareUrlPasteChange,
                onRelayAccessShareUrlChange: handleRelayAccessShareUrlChange,
                relayAccessProviderId: state.context.relayAccessProviderId,
                onRelayAccessProviderIdChange: handleRelayAccessProviderIdChange,
                onRelayAccessProviderDetailsRequested: handleRelayAccessProviderDetailsRequested,
                onWizardPrimaryChange: handleWizardPrimaryChange,
                onWizardBackChange: handleWizardBackChange,
                onWizardSkipChange: handleWizardSkipChange,
                onRequestAdvance: handleRequestAdvance,
                connectedMachineLabel,
                existingSessionCount,
            });
        }
    }

    const primaryLabel =
        primaryOverride?.label
        ?? (stepId === 'setup_chooser'
            ? t('common.continue')
            : stepId === 'done'
                ? t('setupOnboarding.doneStartFirstSession')
                : t('common.continue'));

    const primaryAction = stepId === 'done'
        ? handleStartFirstSession
        : stepId === 'host_relay_local' && localRelayRuntimeSatisfied && primaryOverride?.disabled !== true
            ? handleLocalRelayPrimary
            : (primaryOverride?.onPress ?? onPrimary);
    const setupThisComputerSkipLabel = stepId === 'setup_this_computer' && state.context.platform !== 'desktop'
        ? t('setupOnboarding.setupThisComputerSkipLabel')
        : undefined;
    const skipAction = skipOverride?.hidden
        ? undefined
        : (skipOverride?.onPress ?? (showSkip ? onSkip : undefined));
    const backAction = backOverride?.hidden
        ? undefined
        : (backOverride?.onPress ?? onBack);
    const primaryDisabled =
        primaryOverride?.disabled
        ?? ((stepId === 'setup_chooser' && action == null)
            || (stepId === 'host_relay_local' && state.context.platform === 'desktop' && primaryOverride == null)
            || (stepId === 'host_relay_local'
                && state.context.platform !== 'desktop'
                && (
                    webRelayHostEndpointForReadiness == null
                    || isWebRelayHostUrlInvalid
                    || isWebRelayHostReadinessPending
                    || isWebRelayHostUnavailable
                    || (tailscaleEnsureReadySnapshot != null && tailscaleEnsureReadySnapshot.result == null)
                ))
            || (stepId === 'setup_this_computer' && !localMachineId)
            || (
                stepId === 'confirm_switch_relay'
                && relaySwitchDecision === 'switch'
                && (
                    activeReachabilityRemediation != null
                    || isActiveReachabilityRemediationPending
                    || (tailscaleEnsureReadySnapshot != null && tailscaleEnsureReadySnapshot.result == null)
                )
            ));

    return {
        stepId,
        currentStepIndex,
        stepCount: Math.max(1, progress.total),
        contentTransitionKey: stepId,
        contentTransitionDirection,
        title,
        subtitle,
        scrollable: !props.useOuterScrollContainer,
        body,
        onPrimary: primaryAction,
        primaryLabel,
        primaryDisabled,
        onBack: backAction,
        backLabel: backOverride?.label,
        showBack: backOverride?.hidden ? false : true,
        onSkip: skipAction,
        skipLabel: skipOverride?.label ?? setupThisComputerSkipLabel,
        skipDisabled: skipOverride?.disabled,
        showSkip: skipOverride?.hidden ? false : showSkip,
        footerHint,
        goToStep: (nextStepId: WizardStepId) => {
            dispatch({ type: 'wizard/goToStep', stepId: nextStepId });
        },
    };
}
