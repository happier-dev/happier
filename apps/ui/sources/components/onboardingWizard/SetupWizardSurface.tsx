import * as React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MachineSetupFlowScreen } from '@/components/settings/machines/MachineSetupFlowScreen';
import { RemoteSshMachineSetupSection } from '@/components/settings/machines/RemoteSshMachineSetupSection';
import { LocalRelayRuntimeControlSection } from '@/components/settings/server/localControl/LocalRelayRuntimeControlSection';
import { ProviderSetupFlow } from '@/components/settings/providers/setup/ProviderSetupFlow';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Text, TextInput } from '@/components/ui/text/Text';
import { getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { t, tLoose } from '@/text';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { createWizardState, wizardReducer } from './wizardReducer';
import { canSkipWizardStep, getWizardProgress } from './wizardSelectors';
import type { WizardStepId } from './wizardTypes';
import { WizardModalShell } from './WizardModalShell';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from './ConfirmSwitchRelayStep';
import { SecureAccessTailscaleStep } from './SecureAccessTailscaleStep';
import { getWizardStepDefinition } from './wizardStepRegistry';
import { WizardTerminalHandoff } from './WizardTerminalHandoff';
import { buildAuthLoginCommandForServerUrl, buildCliInstallCommandForCurrentApp } from './wizardCliCommands';
import { buildWebDesktopRelayHostHandoffSteps } from './webDesktopHandoffSteps';
import { WebDesktopDownloadCta } from './WebDesktopDownloadCta';

export type SetupWizardSurfaceProps = Readonly<{
    testID?: string;
    isDesktopShell: boolean;
    onExit?: () => void;
}>;

type SetupAction = 'local' | 'relayLocal' | 'remote' | 'tailscale' | null;
type SetupChooserAction = 'local' | 'relayLocal' | 'remote' | 'tailscale';
type RemoteSetupIntent = 'remoteMachine' | 'remoteRelayHost';

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

type RemoteRelayRuntimeCompletion = Readonly<{
    machineId: string | null;
    serverId: string | null;
    relayRuntimeUrl: string | null;
}>;

function renderSetupStepBody(params: Readonly<{
    theme: ReturnType<typeof useUnistyles>['theme'];
    styles: typeof stylesheet;
    stepId: WizardStepId;
    testIDPrefix: string;
    platform: 'desktop' | 'web' | 'native';
    isDesktopShell: boolean;
    remoteSetupIntent: RemoteSetupIntent;
    activeServerUrl: string | null;
    relayUrl: string | null;
    providerMachineId: string | null;
    onLocalSetupSucceeded: (machineId: string | null) => void;
    relaySwitchDecision: RelaySwitchDecision;
    onRelaySwitchDecisionChange: (decision: RelaySwitchDecision) => void;
    onLocalRelayStatusChange: (status: unknown) => void;
    onRemoteRelayRuntimeCompletedChange: (payload: RemoteRelayRuntimeCompletion) => void;
    onRelayUrlPasteChange: (value: string) => void;
}>): React.ReactNode {
    const requiresDesktop = params.platform === 'web' && !params.isDesktopShell;
    switch (params.stepId) {
        case 'setup_this_computer':
            if (requiresDesktop) {
                const cliInstallCommand = buildCliInstallCommandForCurrentApp();
                const authLoginCommand = params.activeServerUrl
                    ? buildAuthLoginCommandForServerUrl(params.activeServerUrl)
                    : 'happier auth login --persist --method web';
                return (
                    <WizardTerminalHandoff
                        testID="setupWizard-terminal-handoff"
                        steps={[
                            {
                                title: t('sessionGettingStarted.steps.installCli.title'),
                                subtitle: t('sessionGettingStarted.steps.installCli.description'),
                                code: cliInstallCommand,
                                scrollTestIDSuffix: 'cli-install',
                            },
                            {
                                title: t('sessionGettingStarted.steps.authLogin.title'),
                                subtitle: t('sessionGettingStarted.steps.authLogin.description'),
                                code: authLoginCommand,
                                scrollTestIDSuffix: 'auth-login',
                            },
                            {
                                title: t('sessionGettingStarted.steps.daemonInstall.title'),
                                subtitle: t('sessionGettingStarted.steps.daemonInstall.description'),
                                code: 'happier daemon install',
                                scrollTestIDSuffix: 'daemon-install',
                            },
                        ]}
                    />
                );
            }
            return (
                <MachineSetupFlowScreen
                    embedded
                    mode="localOnly"
                    autoStartLocalTask
                    onLocalSetupSucceeded={params.onLocalSetupSucceeded}
                />
            );
        case 'host_relay_local':
            if (requiresDesktop) {
                const cliInstallCommand = buildCliInstallCommandForCurrentApp();
                return (
                    <View testID="setupWizard-web-relay-host-handoff" style={params.styles.webRelayHostHandoff}>
                        <WebDesktopDownloadCta testIDPrefix="setupWizard-web-relay" />
                        <WizardTerminalHandoff
                            testID="setupWizard-terminal-handoff"
                            steps={buildWebDesktopRelayHostHandoffSteps({
                                cliInstallCommand,
                                includeDaemonInstall: true,
                            })}
                        />
                        <View style={params.styles.urlBlock}>
                            <TextInput
                                testID="setupWizard-relay-url-input"
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={params.theme.colors.textSecondary}
                                autoCapitalize="none"
                                autoCorrect={false}
                                onChangeText={params.onRelayUrlPasteChange}
                                style={params.styles.urlInput}
                            />
                            <Text style={params.styles.urlHint}>{t('setupOnboarding.webDesktopOnlyRelayStatusSubtitle')}</Text>
                        </View>
                    </View>
                );
            }
            return <LocalRelayRuntimeControlSection onStatusChange={params.onLocalRelayStatusChange} />;
        case 'remote_ssh_setup':
            if (requiresDesktop) {
                const cliInstallCommand = buildCliInstallCommandForCurrentApp();
                const authLoginCommand = params.activeServerUrl
                    ? buildAuthLoginCommandForServerUrl(params.activeServerUrl)
                    : 'happier auth login --persist --method web';
                const sshCommand =
                    params.remoteSetupIntent === 'remoteRelayHost'
                        ? 'happier machine setup --ssh user@host --install-relay-runtime --yes'
                        : 'happier machine setup --ssh user@host --yes';
                return (
                    <WizardTerminalHandoff
                        testID="setupWizard-terminal-handoff"
                        steps={[
                            {
                                title: t('sessionGettingStarted.steps.installCli.title'),
                                subtitle: t('sessionGettingStarted.steps.installCli.description'),
                                code: cliInstallCommand,
                                scrollTestIDSuffix: 'cli-install',
                            },
                            {
                                title: t('sessionGettingStarted.steps.authLogin.title'),
                                subtitle: t('sessionGettingStarted.steps.authLogin.description'),
                                code: authLoginCommand,
                                scrollTestIDSuffix: 'auth-login',
                            },
                            {
                                title: t('settings.machineSetupSshMachineTitle'),
                                subtitle: t('settings.machineSetupSshMachineSubtitle'),
                                code: sshCommand,
                                scrollTestIDSuffix: 'remote-ssh-setup',
                            },
                        ]}
                    />
                );
            }
            return (
                <RemoteSshMachineSetupSection
                    expanded
                    initialInstallRelayRuntime={params.remoteSetupIntent === 'remoteRelayHost'}
                    onCompletedChange={params.onRemoteRelayRuntimeCompletedChange}
                />
            );
        case 'confirm_switch_relay': {
            const relayUrl = typeof params.relayUrl === 'string' ? params.relayUrl.trim() : '';
            return (
                <ConfirmSwitchRelayStep
                    testIDPrefix={params.testIDPrefix}
                    relayUrl={relayUrl}
                    decision={params.relaySwitchDecision}
                    onDecisionChange={params.onRelaySwitchDecisionChange}
                />
            );
        }
        case 'providers_optional':
            return <ProviderSetupFlow machineId={params.providerMachineId} />;
        case 'secure_access_tailscale':
            if (requiresDesktop) {
                return (
                    <View testID="setupWizard-web-tailscale-handoff" style={params.styles.branchList}>
                        <WebDesktopDownloadCta testIDPrefix="setupWizard-web-tailscale" />
                        <Text style={params.styles.branchHint}>{t('setupOnboarding.webDesktopOnlyBody')}</Text>
                    </View>
                );
            }
            return <SecureAccessTailscaleStep />;
        case 'done':
            return <Text>{t('setupOnboarding.nextActionReady')}</Text>;
        default:
            return <Text>{t('setupOnboarding.postAuthBody')}</Text>;
    }
}

export function SetupWizardSurface(props: SetupWizardSurfaceProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const testIDPrefix = props.testID ?? 'setupWizard';
    const relayDriftBanner = useRelayDriftBanner();
    const activeServerSnapshot = getActiveServerSnapshot();
    const initialPendingSetupIntent = React.useMemo(() => getPendingSetupIntent(), []);
    const resumeFromPending =
        initialPendingSetupIntent?.phase === 'awaiting_auth'
        || initialPendingSetupIntent?.phase === 'post_auth';
    const initialStepId: WizardStepId = resumeFromPending
        ? initialPendingSetupIntent?.branch === 'remoteMachine'
            ? 'remote_ssh_setup'
            : 'setup_this_computer'
        : 'setup_chooser';
    const initialSetupAction: SetupAction = resumeFromPending
        ? initialPendingSetupIntent?.branch === 'remoteMachine'
            ? 'remote'
            : 'local'
        : null;
    const initialRemoteIntent: RemoteSetupIntent = resumeFromPending && initialPendingSetupIntent?.branch === 'remoteMachine'
        ? 'remoteMachine'
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
    const [localMachineId, setLocalMachineId] = React.useState<string | null>(null);
    const [remoteMachineId, setRemoteMachineId] = React.useState<string | null>(null);
    const [remoteSetupIntent, setRemoteSetupIntent] = React.useState<RemoteSetupIntent>(initialRemoteIntent);

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
        dispatch({ type: 'wizard/setSetupAction', setupAction: 'remote' });
    }, [clearRelayRuntimeCandidate]);

    const chooseRemoteRelayHost = React.useCallback(() => {
        clearRelayRuntimeCandidate();
        setLocalMachineId(null);
        setRemoteMachineId(null);
        setRemoteSetupIntent('remoteRelayHost');
        dispatch({ type: 'wizard/setSetupAction', setupAction: 'remote' });
    }, [clearRelayRuntimeCandidate]);

    const onPrimary = React.useCallback(async () => {
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
            dispatch({ type: 'wizard/goToStep', stepId: 'providers_optional' });
            return;
        }
        if (stepId === 'host_relay_local') {
            if (typeof relayCandidateUrl === 'string' && relayCandidateUrl.trim().length > 0) {
                dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: action === 'relayLocal' ? 'done' : 'providers_optional' });
            return;
        }
        if (stepId === 'remote_ssh_setup') {
            if (typeof relayCandidateUrl === 'string' && relayCandidateUrl.trim().length > 0) {
                dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: 'providers_optional' });
            return;
        }
        if (stepId === 'confirm_switch_relay') {
            const nextRelayUrl = typeof relayCandidateUrl === 'string' ? relayCandidateUrl.trim() : '';
            if (!nextRelayUrl) {
                dispatch({ type: 'wizard/goToStep', stepId: action === 'relayLocal' ? 'done' : 'providers_optional' });
                return;
            }

            if (relaySwitchDecision === 'keep') {
                dispatch({ type: 'wizard/goToStep', stepId: action === 'relayLocal' ? 'done' : 'providers_optional' });
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
    }, [action, exitWizard, pendingRelayRuntime?.machineId, props.onExit, relayCandidateUrl, relaySwitchDecision, stepId]);

    const handleLocalRelayStatusChange = React.useCallback((status: unknown) => {
        const relayUrl = (status as { relayUrl?: unknown } | null | undefined)?.relayUrl;
        setRelayRuntimeCandidate(typeof relayUrl === 'string' ? relayUrl : null, null);
    }, [setRelayRuntimeCandidate]);

    const handleRemoteRelayRuntimeCompletedChange = React.useCallback((payload: RemoteRelayRuntimeCompletion) => {
        setRemoteMachineId(payload.machineId);
        const relayUrl = typeof payload.relayRuntimeUrl === 'string' ? payload.relayRuntimeUrl.trim() : '';
        if (relayUrl.length > 0) {
            setRelayRuntimeCandidate(relayUrl, payload.machineId);
        }
    }, [setRelayRuntimeCandidate]);

    const handleRelayUrlPasteChange = React.useCallback((value: string) => {
        setRelayRuntimeCandidate(value, null);
    }, [setRelayRuntimeCandidate]);

    let body: React.ReactNode = null;
    if (stepId === 'setup_chooser') {
        body = (
            <>
                {relayDriftBanner ? <RelayDriftActionCard banner={relayDriftBanner} /> : null}
                <View style={styles.branchList}>
                    <SelectableRow
                        testID={`${props.testID ?? 'setupWizard'}-branch:local`}
                        variant="selectable"
                        selected={action === 'local'}
                        onPress={() => chooseAction('local')}
                        left={<Ionicons name="laptop-outline" size={18} color={action === 'local' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        title={t('settings.machineSetupCurrentMachineTitle')}
                        subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
                        right={<Ionicons name={action === 'local' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'local' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                    />
                    <SelectableRow
                        testID={`${props.testID ?? 'setupWizard'}-branch:relayLocal`}
                        variant="selectable"
                        selected={action === 'relayLocal'}
                        onPress={() => chooseAction('relayLocal')}
                        left={<Ionicons name="cloud-upload-outline" size={18} color={action === 'relayLocal' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        title={t('setupOnboarding.relayOnThisComputerTitle')}
                        subtitle={t('setupOnboarding.relayOnThisComputerSubtitle')}
                        right={<Ionicons name={action === 'relayLocal' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'relayLocal' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                    />
                    <SelectableRow
                        testID={`${props.testID ?? 'setupWizard'}-branch:remote`}
                        variant="selectable"
                        selected={action === 'remote' && remoteSetupIntent === 'remoteMachine'}
                        onPress={chooseRemoteMachineSetup}
                        left={<Ionicons name="server-outline" size={18} color={action === 'remote' && remoteSetupIntent === 'remoteMachine' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        title={t('settings.machineSetupSshMachineTitle')}
                        subtitle={t('settings.machineSetupSshMachineSubtitle')}
                        right={<Ionicons name={action === 'remote' && remoteSetupIntent === 'remoteMachine' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'remote' && remoteSetupIntent === 'remoteMachine' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                    />
                    <SelectableRow
                        testID={`${props.testID ?? 'setupWizard'}-branch:remoteRelay`}
                        variant="selectable"
                        selected={action === 'remote' && remoteSetupIntent === 'remoteRelayHost'}
                        onPress={chooseRemoteRelayHost}
                        left={<Ionicons name="cloud-upload-outline" size={18} color={action === 'remote' && remoteSetupIntent === 'remoteRelayHost' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        title={t('settings.machineSetupSshMachineTitle')}
                        subtitle={`${t('settings.machineSetupSshMachineSubtitle')}\n${t('settings.machineSetupRemoteRelayRuntimeLabel')}`}
                        right={<Ionicons name={action === 'remote' && remoteSetupIntent === 'remoteRelayHost' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'remote' && remoteSetupIntent === 'remoteRelayHost' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                    />
                    <SelectableRow
                        testID={`${props.testID ?? 'setupWizard'}-branch:tailscale`}
                        variant="selectable"
                        selected={action === 'tailscale'}
                        onPress={() => chooseAction('tailscale')}
                        left={<Ionicons name="shield-checkmark-outline" size={18} color={action === 'tailscale' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        title={t('settings.localTailscale.title')}
                        subtitle={t('settings.localTailscale.footer')}
                        right={<Ionicons name={action === 'tailscale' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'tailscale' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                    />
                </View>
                <Text style={styles.branchHint}>{t('setupOnboarding.postAuthBody')}</Text>
            </>
        );
    } else {
        const providerMachineId = action === 'remote' ? remoteMachineId : localMachineId;
        body = renderSetupStepBody({
            theme,
            styles,
            stepId,
            testIDPrefix,
            platform: state.context.platform,
            isDesktopShell: props.isDesktopShell,
            remoteSetupIntent,
            activeServerUrl: activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : null,
            relayUrl: relayCandidateUrl,
            providerMachineId,
            onLocalSetupSucceeded: handleLocalSetupSucceeded,
            relaySwitchDecision,
            onRelaySwitchDecisionChange: setRelaySwitchDecision,
            onLocalRelayStatusChange: handleLocalRelayStatusChange,
            onRemoteRelayRuntimeCompletedChange: handleRemoteRelayRuntimeCompletedChange,
            onRelayUrlPasteChange: handleRelayUrlPasteChange,
        });
    }

    const primaryLabel =
        stepId === 'setup_chooser'
            ? t('common.continue')
            : stepId === 'secure_access_tailscale'
                ? t('common.done')
            : stepId === 'done'
                ? t('common.done')
                : t('common.continue');

    return (
        <WizardModalShell
            testID={props.testID ?? 'setupWizard.surface'}
            stepIndex={Math.max(0, progress.current - 1)}
            stepCount={Math.max(1, progress.total)}
            title={title}
            subtitle={subtitle ?? undefined}
            onSkip={showSkip ? onSkip : undefined}
            onBack={onBack}
            onPrimary={onPrimary}
            primaryLabel={primaryLabel}
            primaryDisabled={stepId === 'setup_chooser' && action == null}
            showBack={true}
        >
            {body}
        </WizardModalShell>
    );
}
