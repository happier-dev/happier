import * as React from 'react';
import { Platform, View } from 'react-native';
import { router } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { type SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { Text } from '@/components/ui/text/Text';
import {
    resolveStepTransitionDirection,
    type StepTransitionDirection,
} from '@/components/ui/motion/StepTransitionFrame';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { t, tLoose } from '@/text';
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
import type { WizardContext, WizardStepId } from '../state/wizardTypes';
import { WizardModalShell } from '../ui/WizardModalShell';
import { type RelaySwitchDecision } from '../steps/ConfirmSwitchRelayStep';
import { getWizardStepDefinition } from '../state/wizardStepRegistry';
import { SetupThisComputerWizardStep } from '../steps/SetupThisComputerWizardStep';
import { RelayHostLocalChecklistStep } from '../checklists/relayHostLocal/RelayHostLocalChecklistStep';
import type { RelayHostLocalChecklistRuntimeStatus } from '../checklists/relayHostLocal/types';
import { WizardChoiceRow } from '../ui/WizardChoiceRow';
import { useWizardChromeOverrides } from '../hooks/useWizardChromeOverrides';
import { useEndpointReadinessMap } from '../hooks/useEndpointReadinessMap';
import { renderSetupStepBody } from './SetupWizardSurface.renderSetupStepBody';
import { resolveRelaySwitchUrl } from './relaySelection/relaySelectionHelpers';

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
        textAlign: 'center',
    },
    branchHint: {
        color: theme.colors.text.secondary,
        textAlign: 'center',
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

export function SetupWizardSurface(props: SetupWizardSurfaceProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const scope = props.scope ?? 'all';
    const setupPolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const activeServerSnapshot = useActiveServerSnapshot();
    // Keep a stable testID prefix for internal wizard controls, regardless of the outer container testID.
    // The route uses `testID="setupWizard.surface"` for the shell; child controls should remain addressable
    // via `setupWizard-*` for unit and Playwright tests.
    const testIDPrefix = 'setupWizard';
    const relayDriftBanner = useRelayDriftBanner();
    const activeRelayUrlRaw = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
    const footerHint = activeRelayUrlRaw
        ? t('setupOnboarding.currentRelayDescription', { relayUrl: toServerUrlDisplay(activeRelayUrlRaw) })
        : null;
    const initialPendingSetupIntent = React.useMemo(() => getPendingSetupIntent(), []);
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
                    platform: props.isDesktopShell ? 'desktop' : (Platform.OS === 'web' ? 'web' : 'native'),
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
    const [webRemoteSshDraft, setWebRemoteSshDraft] = React.useState<SshCredentialsDraft>(() => ({
        username: '',
        host: '',
        port: '',
        authMode: 'agent',
        identityFilePath: '',
        password: '',
    }));
    const providerSelectionProviderIds = React.useMemo(() => getAgentCliSetupSupportedIds(), []);
    const [selectedProviderIds, setSelectedProviderIds] = React.useState<AgentId[]>([]);
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

    const onToggleProviderId = React.useCallback((providerId: AgentId) => {
        setSelectedProviderIds((current) => (
            current.includes(providerId)
                ? current.filter((id) => id !== providerId)
                : [...current, providerId]
        ));
    }, []);

    React.useEffect(() => {
        if (stepId === 'remote_ssh_setup' || !webRemoteSshDraft.password) {
            return;
        }
        setWebRemoteSshDraft((current) => (
            current.password
                ? { ...current, password: '' }
                : current
        ));
    }, [stepId, webRemoteSshDraft.password]);

    React.useEffect(() => {
        if (initialPendingSetupIntent?.phase !== 'awaiting_auth') {
            return;
        }
        setPendingSetupIntent({
            ...initialPendingSetupIntent,
            phase: 'post_auth',
        });
    }, []);

    const handleLocalSetupSucceeded = React.useCallback((machineId: string | null) => {
        const normalized = typeof machineId === 'string' && machineId.trim().length > 0 ? machineId.trim() : null;
        setLocalMachineId((current) => current === normalized ? current : normalized);
    }, []);

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
    const { readinessByEndpoint: relayReadinessByEndpoint, retryEndpoint } = useEndpointReadinessMap({
        endpoints: confirmSwitchRelayEndpointForReadiness ? [confirmSwitchRelayEndpointForReadiness] : [],
        enabled: stepId === 'confirm_switch_relay',
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
    const {
        error: reachabilityRemediationError,
        taskSnapshot: tailscaleEnsureReadySnapshot,
        onAction: handleReachabilityRemediationAction,
    } = useEndpointReachabilityRemediationController({
        remediation: activeReachabilityRemediation,
        endpoint: confirmSwitchRelayEndpointForReadiness,
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

    const onPrimary = React.useCallback(async () => {
        const afterProvidersStepId = setupPolicy.providers.allowProviderSetup ? 'providers_optional' : 'done';

        if (stepId === 'setup_chooser') {
            if (action === 'local') {
                dispatch({ type: 'wizard/goToStep', stepId: 'setup_this_computer' });
                return;
            }
            if (action === 'relayLocal') {
                dispatch({ type: 'wizard/goToStep', stepId: 'host_relay_local' });
                return;
            }
            if (action === 'remote') {
                dispatch({ type: 'wizard/goToStep', stepId: 'remote_ssh_setup' });
                return;
            }
            return;
        }

        if (stepId === 'setup_this_computer') {
            dispatch({ type: 'wizard/goToStep', stepId: afterProvidersStepId });
            return;
        }
        if (stepId === 'host_relay_local') {
            const fallbackRelayUrl = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
            const nextRelayUrl = typeof relayCandidateUrl === 'string' && relayCandidateUrl.trim().length > 0
                ? relayCandidateUrl.trim()
                : fallbackRelayUrl;
            if (nextRelayUrl.length > 0) {
                setRelayRuntimeCandidate(nextRelayUrl, null, { kind: 'local' });
                dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: action === 'relayLocal' ? 'done' : afterProvidersStepId });
            return;
        }
        if (stepId === 'relay_access') {
            if (typeof relayCandidateUrl === 'string' && relayCandidateUrl.trim().length > 0) {
                dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: action === 'relayLocal' ? 'done' : afterProvidersStepId });
            return;
        }
        if (stepId === 'relay_access_prereqs') {
            if (typeof relayCandidateUrl === 'string' && relayCandidateUrl.trim().length > 0) {
                dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: action === 'relayLocal' ? 'done' : afterProvidersStepId });
            return;
        }
        if (stepId === 'remote_ssh_setup') {
            if (typeof relayCandidateUrl === 'string' && relayCandidateUrl.trim().length > 0) {
                dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: afterProvidersStepId });
            return;
        }
        if (stepId === 'confirm_switch_relay') {
            const nextRelayUrl = typeof effectiveRelayCandidateUrl === 'string' ? effectiveRelayCandidateUrl.trim() : '';
            if (!nextRelayUrl) {
                dispatch({ type: 'wizard/goToStep', stepId: action === 'relayLocal' ? 'done' : afterProvidersStepId });
                return;
            }

            if (relaySwitchDecision === 'keep') {
                dispatch({ type: 'wizard/goToStep', stepId: action === 'relayLocal' ? 'done' : afterProvidersStepId });
                return;
            }

            await upsertActivateAndSwitchServer({
                serverUrl: nextRelayUrl,
                source: 'url',
                scope: 'device',
            });

            if (action === 'remote') {
                setPendingSetupIntent({
                    branch: 'remoteMachine',
                    phase: 'awaiting_auth',
                    relayUrl: nextRelayUrl,
                    machineId: pendingRelayRuntime?.machineId ?? null,
                    remoteSetupIntent,
                });
            } else {
                setPendingSetupIntent({
                    branch: 'thisComputer',
                    phase: 'awaiting_auth',
                    relayUrl: nextRelayUrl,
                });
            }

            props.onExit?.();
            router.replace('/');
            return;
        }
        if (stepId === 'providers_optional') {
            dispatch({ type: 'wizard/goToStep', stepId: 'done' });
            return;
        }

        exitWizard();
    }, [action, activeServerSnapshot.serverUrl, effectiveRelayCandidateUrl, exitWizard, pendingRelayRuntime?.machineId, props.onExit, relayCandidateUrl, relaySwitchDecision, remoteSetupIntent, setRelayRuntimeCandidate, setupPolicy.providers.allowProviderSetup, stepId]);

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
        setRelayRuntimeCandidate(value, null, { kind: 'local' });
    }, [setRelayRuntimeCandidate]);

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
        const relayUrlFromStatus = typeof localRelayRuntimeStatus?.relayUrl === 'string' ? localRelayRuntimeStatus.relayUrl.trim() : '';
        const fallbackRelayUrl = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
        const nextRelayUrl = relayUrlFromStatus || fallbackRelayUrl;

        if (nextRelayUrl.length > 0) {
            setRelayRuntimeCandidate(nextRelayUrl, null, { kind: 'local' });
            dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
            return;
        }

        void onPrimary();
    }, [activeServerSnapshot.serverUrl, dispatch, localRelayRuntimeStatus, onPrimary, setRelayRuntimeCandidate]);

    const handleLocalRelayRequestAdvance = React.useCallback((status: RelayHostLocalChecklistRuntimeStatus | null) => {
        const relayUrlFromStatus = typeof status?.relayUrl === 'string' ? status.relayUrl.trim() : '';
        const fallbackRelayUrl = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
        const nextRelayUrl = relayUrlFromStatus || fallbackRelayUrl;

        if (stepId === 'host_relay_local' && nextRelayUrl.length > 0) {
            setRelayRuntimeCandidate(nextRelayUrl, null, { kind: 'local' });
            dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
            return;
        }

        void onPrimary();
    }, [activeServerSnapshot.serverUrl, dispatch, onPrimary, setRelayRuntimeCandidate, stepId]);

    const localRelayRuntimeSatisfied = localRelayRuntimeStatus?.installed === true
        && localRelayRuntimeStatus?.service.active === true
        && localRelayRuntimeStatus?.healthy === true;

    let body: React.ReactNode = null;
    if (stepId === 'setup_chooser') {
        const showLocalMachine = scope !== 'relay' && setupPolicy.machine.allowLocalMachineSetup;
        const showRemoteMachine = scope !== 'relay' && setupPolicy.machine.allowRemoteSshMachineSetup;
        const showRelayHosting = scope !== 'machine' && setupPolicy.relay.allowLocalRelayHost;
        const showRemoteRelayHosting = scope !== 'machine' && setupPolicy.relay.allowRemoteSshRelayHost;

        body = (
            <>
                {relayDriftBanner ? <RelayDriftActionCard banner={relayDriftBanner} /> : null}
                <View style={styles.branchList}>
                    {showLocalMachine ? (
                        <WizardChoiceRow
                            testID={`${testIDPrefix}-branch:local`}
                            selected={action === 'local'}
                            onPress={() => chooseAction('local')}
                            icon="laptop-outline"
                            title={t('settings.machineSetupCurrentMachineTitle')}
                            subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
                        />
                    ) : null}
                    {showRelayHosting ? (
                        <WizardChoiceRow
                            testID={`${testIDPrefix}-branch:relayLocal`}
                            selected={action === 'relayLocal'}
                            onPress={() => chooseAction('relayLocal')}
                            icon="cloud-upload-outline"
                            title={t('setupOnboarding.relayOnThisComputerTitle')}
                            subtitle={t('setupOnboarding.relayOnThisComputerSubtitle')}
                        />
                    ) : null}
                    {showRemoteMachine ? (
                        <WizardChoiceRow
                            testID={`${testIDPrefix}-branch:remote`}
                            selected={action === 'remote' && remoteSetupIntent === 'remoteMachine'}
                            onPress={chooseRemoteMachineSetup}
                            icon="server-outline"
                            title={t('settings.machineSetupSshMachineTitle')}
                            subtitle={t('settings.machineSetupSshMachineSubtitle')}
                        />
                    ) : null}
                    {showRemoteRelayHosting ? (
                        <WizardChoiceRow
                            testID={`${testIDPrefix}-branch:remoteRelay`}
                            selected={action === 'remote' && remoteSetupIntent === 'remoteRelayHost'}
                            onPress={chooseRemoteRelayHost}
                            icon="cloud-upload-outline"
                            title={t('setupOnboarding.relayOnRemoteComputerTitle')}
                            subtitle={t('setupOnboarding.relayOnRemoteComputerSubtitle')}
                        />
                    ) : null}
                </View>
                <Text style={styles.branchHint}>{t('setupOnboarding.postAuthBody')}</Text>
            </>
        );
    } else {
        const providerMachineId = action === 'remote' ? remoteMachineId : localMachineId;
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
                webRemoteSshDraft,
                onWebRemoteSshDraftChange: setWebRemoteSshDraft,
                activeServerUrl: activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : null,
                activeLocalRelayUrl: activeServerSnapshot.activeLocalRelayUrl
                    ? String(activeServerSnapshot.activeLocalRelayUrl).trim()
                    : null,
                relayUrl: relayCandidateUrl,
                confirmRelayUrl: effectiveRelayCandidateUrl,
                serverProfileId: state.context.relaySelection.relayProfileId ?? null,
                relayAccessTarget: relayAccessTarget ?? defaultRelayAccessTarget,
                reachabilityRemediation: activeReachabilityRemediation,
                reachabilityRemediationTaskSnapshot: tailscaleEnsureReadySnapshot,
                reachabilityRemediationError,
                onReachabilityRemediationAction: handleReachabilityRemediationAction,
                providerMachineId,
                providerSelectionProviderIds,
                selectedProviderIds,
                onToggleProviderId,
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
            });
        }
    }

    const primaryLabel =
        primaryOverride?.label
        ?? (stepId === 'setup_chooser'
            ? t('common.continue')
            : stepId === 'done'
                ? t('common.done')
                : t('common.continue'));

    const primaryAction = stepId === 'host_relay_local' && localRelayRuntimeSatisfied && primaryOverride?.disabled !== true
        ? handleLocalRelayPrimary
        : (primaryOverride?.onPress ?? onPrimary);

    return (
        <WizardModalShell
            testID={props.testID ?? 'setupWizard.surface'}
            stepIndex={currentStepIndex}
            stepCount={Math.max(1, progress.total)}
            contentTransitionKey={stepId}
            contentTransitionDirection={contentTransitionDirection}
            title={title}
            subtitle={subtitle ?? undefined}
            scrollable={!props.useOuterScrollContainer}
            onSkip={
                skipOverride?.hidden
                    ? undefined
                    : (skipOverride?.onPress ?? (showSkip ? onSkip : undefined))
            }
            skipLabel={skipOverride?.label}
            skipDisabled={skipOverride?.disabled}
            showSkip={skipOverride?.hidden ? false : showSkip}
            onBack={
                backOverride?.hidden
                    ? undefined
                    : (backOverride?.onPress ?? onBack)
            }
            backLabel={backOverride?.label}
            showBack={backOverride?.hidden ? false : true}
            onPrimary={primaryAction}
            primaryLabel={primaryLabel}
            primaryDisabled={
                primaryOverride?.disabled
                ?? ((stepId === 'setup_chooser' && action == null)
                    || (stepId === 'host_relay_local' && primaryOverride == null)
                    || (stepId === 'setup_this_computer' && state.context.platform !== 'web' && !localMachineId)
                    || (
                        stepId === 'confirm_switch_relay'
                        && relaySwitchDecision === 'switch'
                        && (
                            activeReachabilityRemediation != null
                            || isActiveReachabilityRemediationPending
                            || (tailscaleEnsureReadySnapshot != null && tailscaleEnsureReadySnapshot.result == null)
                        )
                    ))
            }
            footerHint={footerHint}
        >
            {body}
        </WizardModalShell>
    );
}
