import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getProviderLocalAuthPlugin } from '@/agents/providers/registry/providerLocalAuthRegistry';
import { DesktopOnlySetupNotice } from '@/components/settings/machines/DesktopOnlySetupNotice';
import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { ActionCard } from '@/components/ui/cards/ActionCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { Modal } from '@/modal';
import { useMachine } from '@/sync/domains/state/storage';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { ProviderAuthenticationCard } from '../authentication/ProviderAuthenticationCard';
import { ProviderAuthenticationTerminalPane } from '../authentication/ProviderAuthenticationTerminalPane';
import { useProviderAuthenticationState } from '../authentication/useProviderAuthenticationState';
import {
    completeActiveProviderSetupStep,
    createProviderSetupQueueState,
    skipActiveProviderSetupStep,
    type ProviderSetupQueueState,
} from './providerSetupQueue';
import { useProviderCliInstallQueue, type ProviderCliInstallStatus } from './useProviderCliInstallQueue';

const DEFAULT_PROVIDER_IDS = AGENT_IDS.filter((agentId) => agentId !== 'customAcp');

function resolveProviderStepState(params: Readonly<{
    providerId: AgentId;
    queueState: ProviderSetupQueueState | null;
}>): 'idle' | 'active' | 'done' | 'skipped' {
    if (!params.queueState) return 'idle';
    if (params.queueState.activeProviderId === params.providerId) return 'active';
    if (params.queueState.completedProviderIds.includes(params.providerId)) return 'done';
    if (params.queueState.skippedProviderIds?.includes(params.providerId)) return 'skipped';
    return 'idle';
}

function buildProviderStepDetail(stepState: 'idle' | 'active' | 'done' | 'skipped'): string | undefined {
    if (stepState === 'active') return t('settingsProviders.setup.activeStatus');
    if (stepState === 'done') return t('settingsProviders.setup.completedStatus');
    if (stepState === 'skipped') return t('settingsProviders.setup.skippedStatus');
    return undefined;
}

function buildInstallStepDetail(stepState: ProviderCliInstallStatus): string | undefined {
    if (stepState === 'queued') return t('settingsNotifications.badges.queuedTitle');
    if (stepState === 'installing') return t('settingsProviders.setup.activeStatus');
    if (stepState === 'installed') return t('settingsProviders.cliInstaller.installed');
    if (stepState === 'failed') return t('settingsProviders.cliInstaller.installFailed');
    return undefined;
}

export const ProviderSetupFlow = React.memo(function ProviderSetupFlow(props: Readonly<{
    providerIds?: readonly AgentId[];
    machineId?: string | null;
    serverId?: string | null;
}>) {
    if (!isTauriDesktop()) {
        return (
            <DesktopOnlySetupNotice
                testID="settings.providers.setup.desktopOnlyNotice"
                groupTitle={t('settingsProviders.installSetupTitle')}
                title={t('setupOnboarding.webDesktopOnlyTitle')}
                subtitle={t('setupOnboarding.webDesktopOnlyBody')}
            />
        );
    }

    const { theme } = useUnistyles();
    const defaultMachineId = usePrimaryMachineFromActiveSelection();
    const providerIds = React.useMemo(
        () => (props.providerIds?.length ? [...props.providerIds] : [...DEFAULT_PROVIDER_IDS]),
        [props.providerIds],
    );
    const serverId = props.serverId ?? getActiveServerId();
    const machineId = props.machineId ?? defaultMachineId;
    const machine = useMachine(machineId ?? '');
    const machineLabel = machine?.metadata?.displayName ?? machine?.metadata?.host ?? machineId ?? t('machine.detectedCliUnknown');

    const [selectedProviderIds, setSelectedProviderIds] = React.useState<AgentId[]>(() => [...providerIds]);
    const [queueState, setQueueState] = React.useState<ProviderSetupQueueState | null>(null);
    const [terminalProviderId, setTerminalProviderId] = React.useState<AgentId | null>(null);

    React.useEffect(() => {
        setSelectedProviderIds((previous) => {
            const next = providerIds.filter((providerId) => previous.includes(providerId));
            return next.length > 0 ? next : [...providerIds];
        });
    }, [providerIds]);

    const activeProviderId = queueState?.activeProviderId ?? null;
    const activeCore = activeProviderId ? getAgentCore(activeProviderId) : null;
    const authPlugin = activeProviderId ? getProviderLocalAuthPlugin(activeProviderId) : null;
    const cliAvailability = useCLIDetection(machineId, {
        autoDetect: Boolean(machineId),
        agentIds: selectedProviderIds,
        includeLoginStatus: Boolean(activeProviderId),
        includeLoginStatusForAgentIds: activeProviderId ? [activeProviderId] : [],
        serverId,
    });
    const authState = useProviderAuthenticationState({
        providerId: activeProviderId ?? 'codex',
        cliAvailability,
        authPlugin,
        primaryMachine: machine ?? null,
    });
    const providerDetectKeys = React.useMemo(() => {
        const out: Partial<Record<AgentId, string>> = {};
        for (const providerId of selectedProviderIds) {
            out[providerId] = getAgentCore(providerId).cli.detectKey;
        }
        return out;
    }, [selectedProviderIds]);
    const installQueue = useProviderCliInstallQueue({
        machineId,
        serverId,
        providerIds: selectedProviderIds,
        providerDetectKeys,
        installedByProviderId: cliAvailability.available,
    });

    const toggleProvider = React.useCallback((providerId: AgentId) => {
        if (queueState || installQueue.state.hasStarted) return;
        setSelectedProviderIds((previous) => {
            if (previous.includes(providerId)) {
                return previous.filter((entry) => entry !== providerId);
            }
            return [...previous, providerId];
        });
    }, [installQueue.state.hasStarted, queueState]);

    const canStart = selectedProviderIds.length > 0 && Boolean(machineId) && !installQueue.state.isRunning;
    const isFinished = queueState != null && queueState.activeProviderId == null;

    return (
        <View style={{ gap: 14 }}>
            <ItemGroup
                title={t('settingsProviders.installSetupTitle')}
                footer={t('settingsProviders.setup.selectionFooter')}
            >
                <Item
                    title={t('settingsProviders.targetMachineTitle')}
                    subtitle={machineLabel}
                    showChevron={false}
                    mode="info"
                />
                {providerIds.map((providerId) => {
                    const core = getAgentCore(providerId);
                    const selected = selectedProviderIds.includes(providerId);
                    const stepState = resolveProviderStepState({ providerId, queueState });
                    const installStatus = installQueue.resolveStatus(providerId).status;
                    const canRetryInstall = installQueue.state.hasStarted && !installQueue.state.isRunning && installStatus === 'failed';
                    return (
                        <Item
                            key={providerId}
                            testID={`provider-setup-option-${providerId}`}
                            title={t(core.displayNameKey)}
                            subtitle={installQueue.state.hasStarted ? buildInstallStepDetail(installStatus) : buildProviderStepDetail(stepState)}
                            selected={selected}
                            showChevron={false}
                            disabled={installQueue.state.hasStarted ? (installQueue.state.isRunning || !canRetryInstall) : Boolean(queueState)}
                            icon={<Ionicons name={core.ui.agentPickerIconName as any} size={24} color={theme.colors.textSecondary} />}
                            rightElement={
                                installQueue.state.hasStarted
                                    ? installStatus === 'installing'
                                        ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                        : installStatus === 'installed'
                                            ? <Ionicons name="checkmark-circle" size={20} color={theme.colors.accent.blue} />
                                            : installStatus === 'failed'
                                                ? <Ionicons name="alert-circle" size={20} color={theme.colors.textSecondary} />
                                                : installStatus === 'queued'
                                                    ? <Ionicons name="time-outline" size={20} color={theme.colors.textSecondary} />
                                                    : undefined
                                    : selected
                                        ? <Ionicons name="checkmark-circle" size={20} color={theme.colors.accent.blue} />
                                        : undefined
                            }
                            onPress={async () => {
                                if (installQueue.state.hasStarted) {
                                    if (canRetryInstall) {
                                        await installQueue.retry(providerId);
                                    }
                                    return;
                                }
                                toggleProvider(providerId);
                            }}
                        />
                    );
                })}
            </ItemGroup>

            {!queueState && !installQueue.state.hasStarted ? (
                <ActionCard
                    testID="provider-setup-start-card"
                    title={t('settingsProviders.setup.startTitle')}
                    description={t('settingsProviders.setup.startDescription')}
                    disabled={!canStart}
                    primaryAction={{
                        label: t('common.start'),
                        onPress: async () => {
                            if (!canStart) return;

                            const confirmed = await Modal.confirm(
                                t('settingsProviders.setup.startTitle'),
                                t('settingsProviders.setup.startDescription'),
                                {
                                    cancelText: t('common.cancel'),
                                    confirmText: t('common.start'),
                                },
                            );
                            if (!confirmed) return;

                            const summary = await installQueue.start(selectedProviderIds);
                            setQueueState(createProviderSetupQueueState(summary.installedProviderIds));
                        },
                    }}
                />
            ) : null}

            {activeProviderId && activeCore ? (
                <>
                    <ItemGroup title={t('settingsProviders.setup.queueTitle')}>
                        <Item
                            testID={`provider-setup-active-${activeProviderId}`}
                            title={t(activeCore.displayNameKey)}
                            subtitle={t('settingsProviders.setup.activeDescription')}
                            icon={<Ionicons name={activeCore.ui.agentPickerIconName as any} size={24} color={theme.colors.accent.blue} />}
                            showChevron={false}
                            mode="info"
                        />
                    </ItemGroup>
                    <ProviderAuthenticationCard
                        providerId={activeProviderId}
                        state={authState}
                        onCheckNow={() => {
                            cliAvailability.refresh({
                                bypassCache: true,
                                includeLoginStatusForAgentIds: [activeProviderId],
                            });
                        }}
                        onLaunchLogin={() => {
                            setTerminalProviderId(activeProviderId);
                        }}
                    />
                    {terminalProviderId === activeProviderId && authState.loginLaunch ? (
                        <View style={{ minHeight: 320 }}>
                            <ProviderAuthenticationTerminalPane
                                providerId={activeProviderId}
                                machineId={machineId}
                                machineHomeDir={authState.machineHomeDir}
                                loginLaunch={authState.loginLaunch}
                                onRequestClose={() => setTerminalProviderId(null)}
                                onTerminalExit={() => {
                                    cliAvailability.refresh({
                                        bypassCache: true,
                                        includeLoginStatusForAgentIds: [activeProviderId],
                                    });
                                }}
                            />
                        </View>
                    ) : null}
                    <ActionCard
                        testID="provider-setup-queue-card"
                        title={t('settingsProviders.setup.queueTitle')}
                        description={t('settingsProviders.setup.queueDescription', { provider: t(activeCore.displayNameKey) })}
                        primaryAction={{
                            label: (queueState?.pendingProviderIds.length ?? 0) > 0 ? t('common.continue') : t('common.done'),
                            onPress: () => {
                                setTerminalProviderId(null);
                                setQueueState((current) => (current ? completeActiveProviderSetupStep(current) : current));
                            },
                        }}
                        secondaryAction={{
                            label: t('settingsProviders.setup.skipAction'),
                            onPress: () => {
                                setTerminalProviderId(null);
                                setQueueState((current) => (current ? skipActiveProviderSetupStep(current) : current));
                            },
                        }}
                    />
                </>
            ) : null}

            {isFinished ? (
                <ActionCard
                    testID="provider-setup-complete-card"
                    title={t('settingsProviders.setup.completedTitle')}
                    description={t('settingsProviders.setup.completedDescription')}
                    primaryAction={{
                        label: t('common.done'),
                        onPress: () => {
                            setQueueState(null);
                            setTerminalProviderId(null);
                            installQueue.reset();
                        },
                    }}
                />
            ) : null}
        </View>
    );
});
