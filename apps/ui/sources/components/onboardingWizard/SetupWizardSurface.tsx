import * as React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { LocalDaemonControlSection } from '@/components/settings/machines/localControl/LocalDaemonControlSection';
import { RemoteSshMachineSetupSection } from '@/components/settings/machines/RemoteSshMachineSetupSection';
import { LocalRelayRuntimeControlSection } from '@/components/settings/server/localControl/LocalRelayRuntimeControlSection';
import { ProviderSetupFlow } from '@/components/settings/providers/setup/ProviderSetupFlow';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Text } from '@/components/ui/text/Text';
import { setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { t, tLoose } from '@/text';

import { createWizardState, wizardReducer } from './wizardReducer';
import { canSkipWizardStep, getWizardProgress } from './wizardSelectors';
import type { WizardStepId } from './wizardTypes';
import { WizardModalShell } from './WizardModalShell';
import { SecureAccessTailscaleStep } from './SecureAccessTailscaleStep';
import { getWizardStepDefinition } from './wizardStepRegistry';

export type SetupWizardSurfaceProps = Readonly<{
    testID?: string;
    isDesktopShell: boolean;
}>;

type SetupAction = 'local' | 'remote' | 'tailscale' | null;
type RelaySwitchDecision = 'keep' | 'switch';

const stylesheet = StyleSheet.create((theme) => ({
    branchList: {
        width: '100%',
        gap: 6,
    },
    branchHint: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    confirmChoices: {
        width: '100%',
        gap: 6,
    },
    confirmWarning: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
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
    relayUrl: string | null;
    relaySwitchDecision: RelaySwitchDecision;
    onRelaySwitchDecisionChange: (decision: RelaySwitchDecision) => void;
    onLocalRelayStatusChange: (status: unknown) => void;
    onRemoteRelayRuntimeCompletedChange: (payload: RemoteRelayRuntimeCompletion) => void;
}>): React.ReactNode {
    switch (params.stepId) {
        case 'setup_this_computer':
            return <LocalDaemonControlSection />;
        case 'host_relay_local':
            return <LocalRelayRuntimeControlSection onStatusChange={params.onLocalRelayStatusChange} />;
        case 'remote_ssh_setup':
            return (
                <ItemGroup title={t('settings.machineSetupStagesTitle')} footer={t('settings.machineSetupSshMachineSubtitle')}>
                    <Item
                        title={t('settings.machineSetupStageConnect')}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        title={t('settings.machineSetupStageInstall')}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        title={t('settings.machineSetupStageFinish')}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            );
        case 'host_relay_remote':
            return <RemoteSshMachineSetupSection expanded onCompletedChange={params.onRemoteRelayRuntimeCompletedChange} />;
        case 'confirm_switch_relay': {
            const relayUrl = typeof params.relayUrl === 'string' ? params.relayUrl.trim() : '';
            return (
                <>
                    <ItemGroup title={t('setupOnboarding.confirmSwitchRelayTitle')} footer={t('setupOnboarding.confirmSwitchRelaySubtitle')}>
                        <Item
                            testID={`${params.testIDPrefix}-confirmSwitchRelay`}
                            title={t('setupOnboarding.selectedRelayFooterLabel')}
                            subtitle={relayUrl}
                            showChevron={false}
                            mode="info"
                        />
                    </ItemGroup>
                    <View style={params.styles.confirmChoices}>
                        <SelectableRow
                            testID={`${params.testIDPrefix}-confirmSwitchRelay.choice:keep`}
                            variant="selectable"
                            selected={params.relaySwitchDecision === 'keep'}
                            onPress={() => params.onRelaySwitchDecisionChange('keep')}
                            left={
                                <Ionicons
                                    name="remove-circle-outline"
                                    size={18}
                                    color={params.relaySwitchDecision === 'keep' ? params.theme.colors.accent.blue : params.theme.colors.textSecondary}
                                />
                            }
                            title={t('setupOnboarding.confirmSwitchRelayKeepTitle')}
                            subtitle={t('setupOnboarding.confirmSwitchRelayKeepSubtitle')}
                            right={
                                <Ionicons
                                    name={params.relaySwitchDecision === 'keep' ? 'checkmark-circle' : 'ellipse-outline'}
                                    size={18}
                                    color={params.relaySwitchDecision === 'keep' ? params.theme.colors.accent.blue : params.theme.colors.textSecondary}
                                />
                            }
                        />
                        <SelectableRow
                            testID={`${params.testIDPrefix}-confirmSwitchRelay.choice:switch`}
                            variant="selectable"
                            selected={params.relaySwitchDecision === 'switch'}
                            onPress={() => params.onRelaySwitchDecisionChange('switch')}
                            left={
                                <Ionicons
                                    name="swap-horizontal-outline"
                                    size={18}
                                    color={params.relaySwitchDecision === 'switch' ? params.theme.colors.accent.blue : params.theme.colors.textSecondary}
                                />
                            }
                            title={t('setupOnboarding.confirmSwitchRelaySwitchTitle')}
                            subtitle={t('setupOnboarding.confirmSwitchRelaySwitchSubtitle')}
                            right={
                                <Ionicons
                                    name={params.relaySwitchDecision === 'switch' ? 'checkmark-circle' : 'ellipse-outline'}
                                    size={18}
                                    color={params.relaySwitchDecision === 'switch' ? params.theme.colors.accent.blue : params.theme.colors.textSecondary}
                                />
                            }
                        />
                    </View>
                    <Text style={params.styles.confirmWarning}>{t('setupOnboarding.confirmSwitchRelayWarning')}</Text>
                </>
            );
        }
        case 'providers_optional':
            return <ProviderSetupFlow />;
        case 'secure_access_tailscale':
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
                    authIntent: 'standard',
                    setupAction: null,
                },
                currentStepId: 'setup_chooser',
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
        router.replace('/setup');
    }, []);

    const onBack = React.useCallback(() => {
        if (stepId === 'setup_chooser') {
            router.replace('/setup');
            return;
        }
        dispatch({ type: 'wizard/back' });
    }, [stepId]);

    const chooseAction = React.useCallback((nextAction: Exclude<SetupAction, null>) => {
        clearRelayRuntimeCandidate();
        dispatch({ type: 'wizard/setSetupAction', setupAction: nextAction });
    }, [clearRelayRuntimeCandidate]);

    const onPrimary = React.useCallback(async () => {
        if (stepId === 'setup_chooser') {
            if (action === 'local') {
                dispatch({ type: 'wizard/goToStep', stepId: 'setup_this_computer' });
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
            dispatch({ type: 'wizard/goToStep', stepId: 'host_relay_local' });
            return;
        }
        if (stepId === 'host_relay_local') {
            if (typeof relayCandidateUrl === 'string' && relayCandidateUrl.trim().length > 0) {
                dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: 'providers_optional' });
            return;
        }
        if (stepId === 'remote_ssh_setup') {
            dispatch({ type: 'wizard/goToStep', stepId: 'host_relay_remote' });
            return;
        }
        if (stepId === 'host_relay_remote') {
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
                dispatch({ type: 'wizard/goToStep', stepId: 'providers_optional' });
                return;
            }

            if (relaySwitchDecision === 'keep') {
                dispatch({ type: 'wizard/goToStep', stepId: 'providers_optional' });
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

            router.replace('/');
            return;
        }
        if (stepId === 'providers_optional' || stepId === 'secure_access_tailscale') {
            dispatch({ type: 'wizard/goToStep', stepId: 'done' });
            return;
        }

        router.replace('/setup');
    }, [action, pendingRelayRuntime?.machineId, relayCandidateUrl, relaySwitchDecision, stepId]);

    const handleLocalRelayStatusChange = React.useCallback((status: unknown) => {
        const relayUrl = (status as { relayUrl?: unknown } | null | undefined)?.relayUrl;
        setRelayRuntimeCandidate(typeof relayUrl === 'string' ? relayUrl : null, null);
    }, [setRelayRuntimeCandidate]);

    const handleRemoteRelayRuntimeCompletedChange = React.useCallback((payload: RemoteRelayRuntimeCompletion) => {
        setRelayRuntimeCandidate(payload.relayRuntimeUrl, payload.machineId);
    }, [setRelayRuntimeCandidate]);

    let body: React.ReactNode = null;
    if (stepId === 'setup_chooser') {
        body = (
            <>
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
                        testID={`${props.testID ?? 'setupWizard'}-branch:remote`}
                        variant="selectable"
                        selected={action === 'remote'}
                        onPress={() => chooseAction('remote')}
                        left={<Ionicons name="server-outline" size={18} color={action === 'remote' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
                        title={t('settings.machineSetupSshMachineTitle')}
                        subtitle={t('settings.machineSetupSshMachineSubtitle')}
                        right={<Ionicons name={action === 'remote' ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={action === 'remote' ? theme.colors.accent.blue : theme.colors.textSecondary} />}
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
        body = renderSetupStepBody({
            theme,
            styles,
            stepId,
            testIDPrefix,
            relayUrl: relayCandidateUrl,
            relaySwitchDecision,
            onRelaySwitchDecisionChange: setRelaySwitchDecision,
            onLocalRelayStatusChange: handleLocalRelayStatusChange,
            onRemoteRelayRuntimeCompletedChange: handleRemoteRelayRuntimeCompletedChange,
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
