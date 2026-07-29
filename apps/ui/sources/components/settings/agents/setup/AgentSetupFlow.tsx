import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { getAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/agentLocalAuthCatalog';
import { AGENT_IDS, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import {
    AgentsLogoMultiSelect,
    type AgentsLogoMultiSelectEntry,
} from '@/components/onboarding/steps/AgentsLogoMultiSelect';
import { WebDesktopDownloadCta } from '@/components/onboarding/steps/webDesktop/WebDesktopDownloadCta';
import { WizardTerminalHandoff } from '@/components/onboarding/ui/WizardTerminalHandoff';
import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { ActionCard } from '@/components/ui/cards/ActionCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { Modal } from '@/modal';
import { useMachine } from '@/sync/domains/state/storage';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { AgentAuthenticationCard } from '../authentication/AgentAuthenticationCard';
import { AgentAuthenticationTerminalPane } from '../authentication/AgentAuthenticationTerminalPane';
import { useAgentAuthenticationState } from '../authentication/useAgentAuthenticationState';
import {
    buildCliInstallAndRunCommandForCurrentApp,
    buildCliInstallAndRunPowershellCommandForCurrentApp,
} from '@/components/onboarding/commands/wizardCliCommands';
import { buildAgentSetupWizardPrimaryOverride } from './resolveAgentSetupWizardPrimaryOverride';
import {
    completeActiveAgentSetupStep,
    createAgentSetupQueueStateFromInstallSummary,
    skipActiveAgentSetupStep,
    type AgentSetupQueueState,
} from './agentSetupQueue';
import { useAgentCliInstallQueue, type AgentCliInstallStatus } from './useAgentCliInstallQueue';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

function supportsDirectAgentSetup(agentId: AgentId | null | undefined): agentId is AgentId {
    return isAgentId(agentId) && Boolean(getAgentCliRuntimeSpec(agentId).binaryName);
}

const DEFAULT_AGENT_IDS = AGENT_IDS.filter((agentId) => supportsDirectAgentSetup(agentId));
const DEFAULT_AGENT_ENTRIES = DEFAULT_AGENT_IDS.map((agentId) => {
    const core = getAgentCore(agentId);
    return {
        agentId,
        catalogAgentId: agentId,
        title: t(core.displayNameKey),
        iconAgentId: agentId,
        iconName: core.ui.agentPickerIconName,
    } as const;
});

export type AgentSetupEntry = Readonly<{
    agentId: string;
    catalogAgentId?: AgentId | null;
    title: string;
    iconAgentId?: AgentId | null;
    iconName: string;
    subtitle?: string | null;
}>;

function uniqueAgentSetupEntries(entries: readonly AgentSetupEntry[]): AgentSetupEntry[] {
    const entriesById = new Map<string, AgentSetupEntry>();
    for (const entry of entries) {
        if (!entry.agentId.trim()) continue;
        if (!entriesById.has(entry.agentId)) {
            entriesById.set(entry.agentId, entry);
        }
    }
    return [...entriesById.values()];
}

function buildSelectableProviderEntries(entries: readonly AgentSetupEntry[]): AgentsLogoMultiSelectEntry[] {
    return entries.map((entry) => ({
        agentId: entry.agentId,
        iconAgentId: entry.iconAgentId ?? null,
        setupAgentId: entry.catalogAgentId ?? null,
        iconName: entry.iconName,
    }));
}

function uniqueSetupProviderIds(entries: readonly AgentSetupEntry[]): AgentId[] {
    return [
        ...new Set(
            entries
                .map((entry) => entry.catalogAgentId)
                .filter((agentId): agentId is AgentId => supportsDirectAgentSetup(agentId)),
        ),
    ];
}

const AgentSetupFlowWizardWebHandoff = React.memo(function AgentSetupFlowWizardWebHandoff(props: Readonly<{
    agentEntries: readonly AgentSetupEntry[];
}>) {
    const { theme } = useUnistyles();
    const agentEntries = React.useMemo(() => props.agentEntries, [props.agentEntries]);
    const [selectedAgentIds, setSelectedAgentIds] = React.useState<string[]>(() => agentEntries.map((entry) => entry.agentId));

    React.useEffect(() => {
        setSelectedAgentIds((previous) => {
            const next = agentEntries.map((entry) => entry.agentId).filter((agentId) => previous.includes(agentId));
            return next.length > 0 ? next : agentEntries.map((entry) => entry.agentId);
        });
    }, [agentEntries]);

    const toggleAgent = React.useCallback((agentId: string) => {
        setSelectedAgentIds((previous) => {
            if (previous.includes(agentId)) {
                return previous.filter((entry) => entry !== agentId);
            }
            return [...previous, agentId];
        });
    }, []);

    const selectedSetupProviderIds = React.useMemo(
        () => uniqueSetupProviderIds(agentEntries.filter((entry) => selectedAgentIds.includes(entry.agentId))),
        [agentEntries, selectedAgentIds],
    );
    const canLaunchSetupHandoff = selectedSetupProviderIds.length > 0;
    const providerArgv = React.useMemo(() => {
        if (!canLaunchSetupHandoff) {
            return [] as string[];
        }
        return ['--providers', selectedSetupProviderIds.join(','), '--yes'];
    }, [canLaunchSetupHandoff, selectedSetupProviderIds]);

    const providersSetupCommand = React.useMemo(() => buildCliInstallAndRunCommandForCurrentApp({
        action: 'providers-setup',
        args: providerArgv,
    }), [providerArgv]);

    const providersSetupWindowsCommand = React.useMemo(() => buildCliInstallAndRunPowershellCommandForCurrentApp({
        action: 'providers-setup',
        args: providerArgv,
    }), [providerArgv]);

    return (
        <View testID="setupWizard.providers.webHandoff" style={{ gap: 14 }}>
            <View style={{ gap: 12, alignItems: 'center' }}>
                <AgentsLogoMultiSelect
                    testID="provider-setup-wizard-select"
                    agentEntries={buildSelectableProviderEntries(agentEntries)}
                    selectedAgentIds={selectedAgentIds}
                    onToggleAgent={toggleAgent}
                />
                <Text style={{ color: theme.colors.text.secondary, textAlign: 'center' }}>
                    {t('settingsAgents.setup.selectionFooter')}
                </Text>
            </View>
            {canLaunchSetupHandoff ? (
                <WizardTerminalHandoff
                    testID="provider-setup-wizard-terminal"
                    steps={[
                        {
                            title: t('settingsAgents.setup.startTitle'),
                            subtitle: t('settingsAgents.setup.startDescription'),
                            code: providersSetupCommand,
                            windowsCode: providersSetupWindowsCommand,
                            windowsLanguage: 'powershell',
                            scrollTestIDSuffix: 'providers-setup',
                        },
                    ]}
                />
            ) : null}
            {Platform.OS === 'web' ? (
                <WebDesktopDownloadCta testIDPrefix="provider-setup-wizard" />
            ) : null}
        </View>
    );
});

function resolveProviderStepState(params: Readonly<{
    agentId: string;
    queueState: AgentSetupQueueState | null;
}>): 'idle' | 'active' | 'done' | 'skipped' {
    if (!params.queueState) return 'idle';
    if (params.queueState.activeProviderId === params.agentId) return 'active';
    if (params.queueState.completedProviderIds.includes(params.agentId)) return 'done';
    if (params.queueState.skippedProviderIds?.includes(params.agentId)) return 'skipped';
    return 'idle';
}

function buildProviderStepDetail(stepState: 'idle' | 'active' | 'done' | 'skipped'): string | undefined {
    if (stepState === 'active') return t('settingsAgents.setup.activeStatus');
    if (stepState === 'done') return t('settingsAgents.setup.completedStatus');
    if (stepState === 'skipped') return t('settingsAgents.setup.skippedStatus');
    return undefined;
}

function buildInstallStepDetail(stepState: AgentCliInstallStatus): string | undefined {
    if (stepState === 'queued') return t('settingsNotifications.badges.queuedTitle');
    if (stepState === 'installing') return t('settingsAgents.setup.activeStatus');
    if (stepState === 'installed') return t('settingsAgents.cliInstaller.installed');
    if (stepState === 'failed') return t('settingsAgents.cliInstaller.installFailed');
    return undefined;
}

export const AgentSetupFlow = React.memo(function AgentSetupFlow(props: Readonly<{
    agentIds?: readonly AgentId[];
    agentEntries?: readonly AgentSetupEntry[];
    machineId?: string | null;
    serverId?: string | null;
    presentation?: 'settings' | 'wizard';
    onWizardPrimaryChange?: ((state: Readonly<{ label: string; disabled: boolean; onPress: () => void | Promise<void> }> | null) => void) | null;
    onRequestAdvance?: (() => void) | null;
}>) {
    const presentation = props.presentation ?? 'settings';
    const supportsDesktopControls = isTauriDesktop();
    const agentEntries = React.useMemo(
        () => {
            const sourceEntries = props.agentEntries?.length
                ? props.agentEntries
                : (props.agentIds?.length ? props.agentIds : DEFAULT_AGENT_IDS).map((agentId) => {
                    const core = getAgentCore(agentId);
                    return {
                        agentId,
                        catalogAgentId: agentId,
                        title: t(core.displayNameKey),
                        iconAgentId: agentId,
                        iconName: core.ui.agentPickerIconName,
                    } satisfies AgentSetupEntry;
                });
            return uniqueAgentSetupEntries(sourceEntries);
        },
        [props.agentEntries, props.agentIds],
    );
    if (!supportsDesktopControls && presentation === 'wizard') {
        return <AgentSetupFlowWizardWebHandoff agentEntries={agentEntries.length > 0 ? agentEntries : DEFAULT_AGENT_ENTRIES} />;
    }

    const { theme } = useUnistyles();
    const defaultMachineId = usePrimaryMachineFromActiveSelection();
    const serverId = props.serverId ?? getActiveServerId();
    const machineId = props.machineId ?? defaultMachineId;
    const machine = useMachine(machineId ?? '');
    const machineLabel = machine?.metadata?.displayName ?? machine?.metadata?.host ?? machineId ?? t('machine.detectedCliUnknown');
    const isWizardPresentation = presentation === 'wizard';

    const [selectedAgentIds, setSelectedAgentIds] = React.useState<string[]>(() => agentEntries.map((entry) => entry.agentId));
    const [queueState, setQueueState] = React.useState<AgentSetupQueueState | null>(null);
    const [terminalProviderId, setTerminalProviderId] = React.useState<string | null>(null);

    React.useEffect(() => {
        setSelectedAgentIds((previous) => {
            const next = agentEntries.map((entry) => entry.agentId).filter((agentId) => previous.includes(agentId));
            return next.length > 0 ? next : agentEntries.map((entry) => entry.agentId);
        });
    }, [agentEntries]);

    const activeProviderId = queueState?.activeProviderId ?? null;
    const activeEntry = React.useMemo(
        () => agentEntries.find((entry) => entry.agentId === activeProviderId) ?? null,
        [activeProviderId, agentEntries],
    );
    const activeSetupProviderId = activeEntry?.catalogAgentId ?? null;
    const activeCore = activeSetupProviderId ? getAgentCore(activeSetupProviderId) : null;
    const authPlugin = activeSetupProviderId ? getAgentLocalAuthPlugin(activeSetupProviderId) : null;
    const selectedSetupProviderIds = React.useMemo(
        () => uniqueSetupProviderIds(agentEntries.filter((entry) => selectedAgentIds.includes(entry.agentId))),
        [agentEntries, selectedAgentIds],
    );
    const hasRunnableSelectedProviders = selectedSetupProviderIds.length > 0;
    const cliAvailability = useCLIDetection(machineId, {
        autoDetect: Boolean(machineId),
        agentIds: selectedSetupProviderIds,
        includeLoginStatus: Boolean(activeSetupProviderId),
        includeLoginStatusForAgentIds: activeSetupProviderId ? [activeSetupProviderId] : [],
        serverId,
    });
    const authState = useAgentAuthenticationState({
        agentId: activeSetupProviderId,
        cliAvailability,
        authPlugin,
        primaryMachine: machine ?? null,
    });
    const agentDetectKeys = React.useMemo(() => {
        const out: Partial<Record<AgentId, string>> = {};
        for (const agentId of selectedSetupProviderIds) {
            out[agentId] = getAgentCore(agentId).cli.detectKey;
        }
        return out;
    }, [selectedSetupProviderIds]);
    const installQueue = useAgentCliInstallQueue({
        machineId,
        serverId,
        agentIds: selectedSetupProviderIds,
        agentDetectKeys,
        installedByAgentId: cliAvailability.available,
    });

    const toggleAgent = React.useCallback((agentId: string) => {
        if (queueState || installQueue.state.hasStarted) return;
        setSelectedAgentIds((previous) => {
            if (previous.includes(agentId)) {
                return previous.filter((entry) => entry !== agentId);
            }
            return [...previous, agentId];
        });
    }, [installQueue.state.hasStarted, queueState]);

    const canStart = selectedAgentIds.length > 0 && hasRunnableSelectedProviders && Boolean(machineId) && !installQueue.state.isRunning;
    const isFinished = queueState != null && queueState.activeProviderId == null;

    const startSetup = React.useCallback(async () => {
        if (!canStart) return;

        const confirmed = await Modal.confirm(
            t('settingsAgents.setup.startTitle'),
            t('settingsAgents.setup.startDescription'),
            {
                cancelText: t('common.cancel'),
                confirmText: t('common.start'),
            },
        );
        if (!confirmed) return;

        const selectedEntries = agentEntries.filter((entry) => selectedAgentIds.includes(entry.agentId));
        const summary = await installQueue.start(uniqueSetupProviderIds(selectedEntries));
        const installedProviderIdSet = new Set(summary.installedAgentIds);
        const failedProviderIdSet = new Set(summary.failedAgentIds);
        setQueueState(createAgentSetupQueueStateFromInstallSummary({
            selectedAgentIds: selectedEntries.map((entry) => entry.agentId),
            installedAgentIds: selectedEntries
                .filter((entry) => entry.catalogAgentId != null && installedProviderIdSet.has(entry.catalogAgentId))
                .map((entry) => entry.agentId),
            failedAgentIds: selectedEntries
                .filter((entry) => entry.catalogAgentId != null && failedProviderIdSet.has(entry.catalogAgentId))
                .map((entry) => entry.agentId),
        }));
    }, [canStart, installQueue, agentEntries, selectedAgentIds]);

    const continueQueue = React.useCallback(() => {
        setTerminalProviderId(null);
        setQueueState((current) => (current ? completeActiveAgentSetupStep(current) : current));
    }, []);

    const finishSetup = React.useCallback(() => {
        setQueueState(null);
        setTerminalProviderId(null);
        installQueue.reset();
    }, [installQueue]);

    React.useEffect(() => {
        if (!isWizardPresentation || !props.onWizardPrimaryChange) return;

        const phase = isFinished ? 'complete' : activeProviderId ? 'queue' : 'select';
        const hasPendingProviders = (queueState?.pendingProviderIds.length ?? 0) > 0;
        const labels = { start: t('common.start'), continue: t('common.continue'), done: t('common.done') };

        const override = buildAgentSetupWizardPrimaryOverride({
            phase,
            canStart,
            hasPendingProviders,
            labels,
            start: startSetup,
            continueQueue,
            finish: finishSetup,
            onRequestAdvance: props.onRequestAdvance ?? undefined,
        });

        props.onWizardPrimaryChange(override);
        return () => props.onWizardPrimaryChange?.(null);
    }, [
        activeProviderId,
        canStart,
        continueQueue,
        finishSetup,
        isFinished,
        isWizardPresentation,
        props.onRequestAdvance,
        props.onWizardPrimaryChange,
        queueState?.pendingProviderIds.length,
        startSetup,
    ]);

    return (
        <View style={{ gap: 14 }}>
            {isWizardPresentation ? (
                <View style={{ gap: 12, alignItems: 'center' }}>
                    <AgentsLogoMultiSelect
                        testID="provider-setup-wizard-select"
                        agentEntries={buildSelectableProviderEntries(agentEntries)}
                        selectedAgentIds={selectedAgentIds}
                        onToggleAgent={toggleAgent}
                    />
                    <Text style={{ color: theme.colors.text.secondary, textAlign: 'center' }}>
                        {t('settingsAgents.setup.selectionFooter')}
                    </Text>
                </View>
            ) : (
                <ItemGroup
                    title={t('settingsAgents.installSetupTitle')}
                    footer={t('settingsAgents.setup.selectionFooter')}
                >
                    <Item
                        title={t('settingsAgents.targetMachineTitle')}
                        subtitle={machineLabel}
                        showChevron={false}
                        mode="info"
                    />
                    {agentEntries.map((entry) => {
                        const selected = selectedAgentIds.includes(entry.agentId);
                        const stepState = resolveProviderStepState({ agentId: entry.agentId, queueState });
                        const installStatus = entry.catalogAgentId ? installQueue.resolveStatus(entry.catalogAgentId).status : 'idle';
                        const iconName = entry.iconAgentId ? getAgentCore(entry.iconAgentId).ui.agentPickerIconName : entry.iconName;
                        const canRetryInstall = installQueue.state.hasStarted && !installQueue.state.isRunning && installStatus === 'failed';
                        return (
                            <Item
                                key={entry.agentId}
                                testID={`provider-setup-option-${entry.agentId}`}
                                title={entry.title}
                                subtitle={installQueue.state.hasStarted ? buildInstallStepDetail(installStatus) : buildProviderStepDetail(stepState)}
                                selected={selected}
                                showChevron={false}
                                disabled={installQueue.state.hasStarted ? (installQueue.state.isRunning || !canRetryInstall) : Boolean(queueState)}
                                icon={<Ionicons name={iconName as any} size={24} color={theme.colors.text.secondary} />}
                                rightElement={
                                    installQueue.state.hasStarted
                                        ? installStatus === 'installing'
                                            ? <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                            : installStatus === 'installed'
                                                ? <Ionicons name="checkmark-circle" size={20} color={theme.colors.accent.blue} />
                                                : installStatus === 'failed'
                                                    ? <Ionicons name="alert-circle" size={20} color={theme.colors.text.secondary} />
                                                    : installStatus === 'queued'
                                                        ? <Ionicons name="time-outline" size={20} color={theme.colors.text.secondary} />
                                                        : undefined
                                        : selected
                                            ? <Ionicons name="checkmark-circle" size={20} color={theme.colors.accent.blue} />
                                            : undefined
                                }
                                onPress={async () => {
                                    if (installQueue.state.hasStarted) {
                                        if (canRetryInstall && entry.catalogAgentId) {
                                            await installQueue.retry(entry.catalogAgentId);
                                        }
                                        return;
                                    }
                                    toggleAgent(entry.agentId);
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {!isWizardPresentation && !queueState && !installQueue.state.hasStarted ? (
                <ActionCard
                    testID="provider-setup-start-card"
                    title={t('settingsAgents.setup.startTitle')}
                    description={t('settingsAgents.setup.startDescription')}
                    disabled={!canStart}
                    primaryAction={{
                        label: t('common.start'),
                        onPress: startSetup,
                    }}
                />
            ) : null}

            {activeProviderId && activeEntry ? (
                <>
                    {(() => {
                        const activeIconName = activeEntry.iconAgentId
                            ? getAgentCore(activeEntry.iconAgentId).ui.agentPickerIconName
                            : activeEntry.iconName;
                        return (
                            <>
                    {!isWizardPresentation ? (
                        <ItemGroup title={t('settingsAgents.setup.queueTitle')}>
                            <Item
                                testID={`provider-setup-active-${activeProviderId}`}
                                title={activeEntry.title}
                                subtitle={t('settingsAgents.setup.activeDescription')}
                                icon={<Ionicons name={activeIconName as any} size={24} color={theme.colors.accent.blue} />}
                                showChevron={false}
                                mode="info"
                            />
                        </ItemGroup>
                    ) : null}
                    {isWizardPresentation ? (
                        <View
                            testID={`provider-setup-active-${activeProviderId}`}
                            style={{ width: '100%', flexDirection: 'row', alignItems: 'center', gap: 10 }}
                        >
                            <Ionicons name={activeIconName as any} size={24} color={theme.colors.accent.blue} />
                            <View style={{ flex: 1, gap: 2 }}>
                                <Text>{activeEntry.title}</Text>
                                <Text style={{ color: theme.colors.text.secondary }}>
                                    {t('settingsAgents.setup.activeDescription')}
                                </Text>
                            </View>
                        </View>
                    ) : null}
                            </>
                        );
                    })()}
                    <AgentAuthenticationCard
                        agentId={activeEntry.agentId}
                        runtimeAgentId={activeSetupProviderId}
                        state={authState}
                        showActions={supportsDesktopControls}
                        onCheckNow={() => {
                            if (!activeSetupProviderId) return;
                            cliAvailability.refresh({
                                bypassCache: true,
                                includeLoginStatusForAgentIds: [activeSetupProviderId],
                            });
                        }}
                        onLaunchLogin={() => {
                            if (!supportsDesktopControls) return;
                            setTerminalProviderId(activeProviderId);
                        }}
                    />
                    {supportsDesktopControls && terminalProviderId === activeProviderId && authState.loginLaunch && activeSetupProviderId ? (
                        <View style={{ minHeight: 320 }}>
                            <AgentAuthenticationTerminalPane
                                agentId={activeSetupProviderId}
                                machineId={machineId}
                                machineHomeDir={authState.machineHomeDir}
                                loginLaunch={authState.loginLaunch}
                                onRequestClose={() => setTerminalProviderId(null)}
                                onTerminalExit={() => {
                                    cliAvailability.refresh({
                                        bypassCache: true,
                                        includeLoginStatusForAgentIds: [activeSetupProviderId],
                                    });
                                }}
                            />
                        </View>
                    ) : null}
                    {!isWizardPresentation ? (
                        <ActionCard
                            testID="provider-setup-queue-card"
                            title={t('settingsAgents.setup.queueTitle')}
                            description={t('settingsAgents.setup.queueDescription', { provider: activeEntry.title })}
                            primaryAction={{
                                label: (queueState?.pendingProviderIds.length ?? 0) > 0 ? t('common.continue') : t('common.done'),
                                onPress: continueQueue,
                            }}
                            secondaryAction={{
                                label: t('settingsAgents.setup.skipAction'),
                                onPress: () => {
                                    setTerminalProviderId(null);
                                    setQueueState((current) => (current ? skipActiveAgentSetupStep(current) : current));
                                },
                            }}
                        />
                    ) : (
                        <Text
                            accessibilityRole="button"
                            testID="provider-setup-skip-active"
                            style={{ color: theme.colors.accent.blue }}
                            onPress={() => {
                                setTerminalProviderId(null);
                                setQueueState((current) => (current ? skipActiveAgentSetupStep(current) : current));
                            }}
                        >
                            {t('settingsAgents.setup.skipAction')}
                        </Text>
                    )}
                </>
            ) : null}

            {!isWizardPresentation && isFinished ? (
                <ActionCard
                    testID="provider-setup-complete-card"
                    title={t('settingsAgents.setup.completedTitle')}
                    description={t('settingsAgents.setup.completedDescription')}
                    primaryAction={{
                        label: t('common.done'),
                        onPress: () => {
                            finishSetup();
                        },
                    }}
                />
            ) : null}

            {isWizardPresentation && installQueue.state.hasStarted && !queueState ? (
                <View testID="provider-setup-wizard-install-status" style={{ width: '100%', gap: 10 }}>
                    {agentEntries.map((entry) => {
                        const selected = selectedAgentIds.includes(entry.agentId);
                        if (!selected) return null;

                        const status = entry.catalogAgentId ? installQueue.resolveStatus(entry.catalogAgentId).status : 'idle';
                        const iconName = entry.iconAgentId ? getAgentCore(entry.iconAgentId).ui.agentPickerIconName : entry.iconName;
                        return (
                            <View key={entry.agentId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                <Ionicons name={iconName as any} size={22} color={theme.colors.text.secondary} />
                                <View style={{ flex: 1, gap: 2 }}>
                                    <Text>{entry.title}</Text>
                                    <Text style={{ color: theme.colors.text.secondary }}>
                                        {buildInstallStepDetail(status) ?? t('settingsNotifications.badges.queuedTitle')}
                                    </Text>
                                </View>
                                {status === 'installing' ? (
                                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                ) : status === 'installed' ? (
                                    <Ionicons name="checkmark-circle" size={20} color={theme.colors.accent.blue} />
                                ) : status === 'failed' ? (
                                    <Ionicons name="alert-circle" size={20} color={theme.colors.text.secondary} />
                                ) : status === 'queued' ? (
                                    <Ionicons name="time-outline" size={20} color={theme.colors.text.secondary} />
                                ) : null}
                            </View>
                        );
                    })}
                </View>
            ) : null}

            {isWizardPresentation && isFinished ? (
                <Text testID="provider-setup-wizard-complete" style={{ color: theme.colors.text.secondary, textAlign: 'center' }}>
                    {t('settingsAgents.setup.completedDescription')}
                </Text>
            ) : null}
        </View>
    );
});
