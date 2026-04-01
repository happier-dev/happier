import * as React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { type SshCredentialsDraft } from '@/components/settings/machines/shared/SshCredentialsFields';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Text } from '@/components/ui/text/Text';
import { getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { t, tLoose } from '@/text';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { getProviderCliSetupSupportedIds, type AgentId } from '@happier-dev/agents';

import { createWizardState, wizardReducer } from '../wizardReducer';
import { canSkipWizardStep, getWizardProgress } from '../wizardSelectors';
import type { WizardContext, WizardStepId } from '../wizardTypes';
import { WizardModalShell } from '../WizardModalShell';
import { type RelaySwitchDecision } from '../ConfirmSwitchRelayStep';
import { getWizardStepDefinition } from '../wizardStepRegistry';
import { SetupThisComputerWizardStep } from '../SetupThisComputerWizardStep';
import { RelayHostLocalChecklistStep } from '../relayHostLocalChecklist/RelayHostLocalChecklistStep';
import { renderSetupStepBody } from './SetupWizardSurface.renderSetupStepBody';

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
type SetupChooserAction = 'local' | 'relayLocal' | 'remote' | 'tailscale';
export type RemoteSetupIntent = 'remoteMachine' | 'remoteRelayHost';

export type WizardPrimaryOverride = Readonly<{
    label: string;
    disabled: boolean;
    onPress: (() => void) | (() => Promise<void>);
}>;

export type WizardBackOverride = Readonly<{
    hidden?: boolean;
    label?: React.ReactNode;
    onPress?: () => void;
}>;

export type WizardSkipOverride = Readonly<{
    hidden?: boolean;
    label?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
}>;

type ScopedOverride<T> = Readonly<{ __stepId: WizardStepId }> & T;

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
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        color: theme.colors.text,
    },
    urlHint: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    branchHint: {
        color: theme.colors.textSecondary,
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
    mode: RemoteSetupIntent;
}>;

export function SetupWizardSurface(props: SetupWizardSurfaceProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const scope = props.scope ?? 'all';
    const setupPolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const activeServerSnapshot = getActiveServerSnapshot();
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
            case 'secure_access_tailscale':
                return 'tailscale';
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
    const [, setPendingRelayShareUrl] = React.useState<string | null>(null);
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
    const providerSelectionProviderIds = React.useMemo(() => getProviderCliSetupSupportedIds(), []);
    const [selectedProviderIds, setSelectedProviderIds] = React.useState<AgentId[]>([]);

    const [primaryOverride, setPrimaryOverride] = React.useState<ScopedOverride<WizardPrimaryOverride> | null>(null);
    const [backOverride, setBackOverride] = React.useState<ScopedOverride<WizardBackOverride> | null>(null);
    const [skipOverride, setSkipOverride] = React.useState<ScopedOverride<WizardSkipOverride> | null>(null);

    React.useEffect(() => {
        setPrimaryOverride((current) => (current && current.__stepId === stepId ? current : null));
        setBackOverride((current) => (current && current.__stepId === stepId ? current : null));
        setSkipOverride((current) => (current && current.__stepId === stepId ? current : null));
    }, [stepId]);

    const handleWizardPrimaryChange = React.useCallback((next: WizardPrimaryOverride | null) => {
        setPrimaryOverride(next ? { __stepId: stepId, ...next } : null);
    }, [stepId]);

    const handleWizardBackChange = React.useCallback((next: WizardBackOverride | null) => {
        setBackOverride(next ? { __stepId: stepId, ...next } : null);
    }, [stepId]);

    const handleWizardSkipChange = React.useCallback((next: WizardSkipOverride | null) => {
        setSkipOverride(next ? { __stepId: stepId, ...next } : null);
    }, [stepId]);

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

    const providersSetupCommand = React.useMemo(() => {
        if (selectedProviderIds.length === 0) return 'happier providers setup';
        return `happier providers setup --providers ${selectedProviderIds.join(',')}`;
    }, [selectedProviderIds]);

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

    const handleLocalSetupNeedsApproval = React.useCallback(() => {
        router.push('/inbox');
    }, []);

    const clearRelayRuntimeCandidate = React.useCallback(() => {
        setRelaySwitchDecision('keep');
        setPendingRelayRuntime(null);
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: { choiceId: null, serverUrl: null, locked: false },
        });
    }, []);

    const setRelayRuntimeCandidate = React.useCallback((relayUrl: string | null, machineId: string | null) => {
        const normalized = String(relayUrl ?? '').trim();
        if (!normalized) {
            clearRelayRuntimeCandidate();
            return;
        }
        setPendingRelayRuntime({ relayUrl: normalized, machineId });
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: { choiceId: 'customUrl', serverUrl: normalized, locked: true },
        });
    }, [clearRelayRuntimeCandidate]);

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
            if (action === 'tailscale') {
                dispatch({ type: 'wizard/goToStep', stepId: 'secure_access_tailscale' });
            }
            return;
        }

        if (stepId === 'setup_this_computer') {
            dispatch({ type: 'wizard/goToStep', stepId: afterProvidersStepId });
            return;
        }
        if (stepId === 'host_relay_local') {
            if (typeof relayCandidateUrl === 'string' && relayCandidateUrl.trim().length > 0) {
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
        if (stepId === 'remote_ssh_setup') {
            if (typeof relayCandidateUrl === 'string' && relayCandidateUrl.trim().length > 0) {
                dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: afterProvidersStepId });
            return;
        }
        if (stepId === 'confirm_switch_relay') {
            const nextRelayUrl = typeof relayCandidateUrl === 'string' ? relayCandidateUrl.trim() : '';
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
        if (stepId === 'providers_optional' || stepId === 'secure_access_tailscale') {
            dispatch({ type: 'wizard/goToStep', stepId: 'done' });
            return;
        }

        exitWizard();
    }, [action, exitWizard, pendingRelayRuntime?.machineId, props.onExit, relayCandidateUrl, relaySwitchDecision, remoteSetupIntent, setupPolicy.providers.allowProviderSetup, stepId]);

    const handleLocalRelayStatusChange = React.useCallback((status: unknown) => {
        const relayUrl = (status as { relayUrl?: unknown } | null | undefined)?.relayUrl;
        setRelayRuntimeCandidate(typeof relayUrl === 'string' ? relayUrl : null, null);
    }, [setRelayRuntimeCandidate]);

    const handleRemoteRelayRuntimeCompletedChange = React.useCallback((payload: RemoteRelayRuntimeCompletion) => {
        setRemoteMachineId(payload.machineId);
        const relayUrl = typeof payload.relayRuntimeUrl === 'string' ? payload.relayRuntimeUrl.trim() : '';
        if (relayUrl.length > 0) {
            setRelayRuntimeCandidate(relayUrl, payload.machineId);
            persistRemoteSetupIntent('remoteRelayHost', relayUrl, payload.machineId);
        }
    }, [persistRemoteSetupIntent, setRelayRuntimeCandidate]);

    const handleRelayUrlPasteChange = React.useCallback((value: string) => {
        setRelayRuntimeCandidate(value, null);
    }, [setRelayRuntimeCandidate]);

    const handleRelayShareUrlPasteChange = React.useCallback((value: string) => {
        const normalized = String(value ?? '').trim();
        setPendingRelayShareUrl(normalized.length > 0 ? normalized : null);
    }, []);

    let body: React.ReactNode = null;
    if (stepId === 'setup_chooser') {
        const showLocalMachine = scope !== 'relay' && setupPolicy.machine.allowLocalMachineSetup;
        const showRemoteMachine = scope !== 'relay' && setupPolicy.machine.allowRemoteSshMachineSetup;
        const showRelayHosting = scope !== 'machine' && setupPolicy.relay.allowLocalRelayHost;
        const showRemoteRelayHosting = scope !== 'machine' && setupPolicy.relay.allowRemoteSshRelayHost;
        const showTailscale =
            scope !== 'machine'
            && setupPolicy.relay.allowLocalRelayHost
            && setupPolicy.relayAccess.allowTailscale;

        body = (
            <>
                {relayDriftBanner ? <RelayDriftActionCard banner={relayDriftBanner} /> : null}
                <View style={styles.branchList}>
                    {showLocalMachine ? (
                        <SelectableRow
                            testID={`${testIDPrefix}-branch:local`}
                            variant="selectable"
                            selected={action === 'local'}
                            onPress={() => chooseAction('local')}
                            left={<Ionicons name="laptop-outline" size={18} color={action === 'local' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                            title={t('settings.machineSetupCurrentMachineTitle')}
                            subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
                            right={<Ionicons name={action === 'local' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'local' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        />
                    ) : null}
                    {showRelayHosting ? (
                        <SelectableRow
                            testID={`${testIDPrefix}-branch:relayLocal`}
                            variant="selectable"
                            selected={action === 'relayLocal'}
                            onPress={() => chooseAction('relayLocal')}
                            left={<Ionicons name="cloud-upload-outline" size={18} color={action === 'relayLocal' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                            title={t('setupOnboarding.relayOnThisComputerTitle')}
                            subtitle={t('setupOnboarding.relayOnThisComputerSubtitle')}
                            right={<Ionicons name={action === 'relayLocal' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'relayLocal' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        />
                    ) : null}
                    {showRemoteMachine ? (
                        <SelectableRow
                            testID={`${testIDPrefix}-branch:remote`}
                            variant="selectable"
                            selected={action === 'remote' && remoteSetupIntent === 'remoteMachine'}
                            onPress={chooseRemoteMachineSetup}
                            left={<Ionicons name="server-outline" size={18} color={action === 'remote' && remoteSetupIntent === 'remoteMachine' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                            title={t('settings.machineSetupSshMachineTitle')}
                            subtitle={t('settings.machineSetupSshMachineSubtitle')}
                            right={<Ionicons name={action === 'remote' && remoteSetupIntent === 'remoteMachine' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'remote' && remoteSetupIntent === 'remoteMachine' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        />
                    ) : null}
                    {showRemoteRelayHosting ? (
                        <SelectableRow
                            testID={`${testIDPrefix}-branch:remoteRelay`}
                            variant="selectable"
                            selected={action === 'remote' && remoteSetupIntent === 'remoteRelayHost'}
                            onPress={chooseRemoteRelayHost}
                            left={<Ionicons name="cloud-upload-outline" size={18} color={action === 'remote' && remoteSetupIntent === 'remoteRelayHost' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                            title={t('setupOnboarding.relayOnRemoteComputerTitle')}
                            subtitle={t('setupOnboarding.relayOnRemoteComputerSubtitle')}
                            right={<Ionicons name={action === 'remote' && remoteSetupIntent === 'remoteRelayHost' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'remote' && remoteSetupIntent === 'remoteRelayHost' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        />
                    ) : null}
                    {showTailscale ? (
                        <SelectableRow
                            testID={`${testIDPrefix}-branch:tailscale`}
                            variant="selectable"
                            selected={action === 'tailscale'}
                            onPress={() => chooseAction('tailscale')}
                            left={<Ionicons name="shield-checkmark-outline" size={18} color={action === 'tailscale' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                            title={t('settings.localTailscale.title')}
                            subtitle={t('settings.localTailscale.footer')}
                            right={<Ionicons name={action === 'tailscale' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'tailscale' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
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
                    onNeedsApproval={handleLocalSetupNeedsApproval}
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
                    onRequestAdvance={() => void onPrimary()}
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
                providerMachineId,
                providerSelectionProviderIds,
                selectedProviderIds,
                onToggleProviderId,
                providersSetupCommand,
                onLocalSetupSucceeded: handleLocalSetupSucceeded,
                onLocalSetupNeedsAuth: handleLocalSetupNeedsAuth,
                onLocalSetupNeedsApproval: handleLocalSetupNeedsApproval,
                relaySwitchDecision,
                onRelaySwitchDecisionChange: setRelaySwitchDecision,
                onLocalRelayStatusChange: handleLocalRelayStatusChange,
                onRemoteRelayRuntimeCompletedChange: handleRemoteRelayRuntimeCompletedChange,
                onRelayUrlPasteChange: handleRelayUrlPasteChange,
                onRelayShareUrlPasteChange: handleRelayShareUrlPasteChange,
                onWizardPrimaryChange: handleWizardPrimaryChange,
                onWizardBackChange: handleWizardBackChange,
                onWizardSkipChange: handleWizardSkipChange,
                onRequestAdvance: () => void onPrimary(),
            });
        }
    }

    const primaryLabel =
        primaryOverride?.label
        ?? (stepId === 'setup_chooser'
            ? t('common.continue')
            : stepId === 'secure_access_tailscale'
                ? t('common.done')
            : stepId === 'done'
                ? t('common.done')
                : t('common.continue'));

    return (
        <WizardModalShell
            testID={props.testID ?? 'setupWizard.surface'}
            stepIndex={Math.max(0, progress.current - 1)}
            stepCount={Math.max(1, progress.total)}
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
            onPrimary={primaryOverride?.onPress ?? onPrimary}
            primaryLabel={primaryLabel}
	            primaryDisabled={
	                primaryOverride?.disabled
	                ?? ((stepId === 'setup_chooser' && action == null)
	                    || (stepId === 'setup_this_computer' && state.context.platform !== 'web' && !localMachineId))
	            }
	            footerHint={footerHint}
	        >
	            {body}
	        </WizardModalShell>
    );
}
