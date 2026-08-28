import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { getAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/agentLocalAuthCatalog';
import { AGENT_IDS, getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import {
    getResolvedAgentCatalogEntries,
    type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import {
    AgentsLogoMultiSelect,
    type AgentsLogoMultiSelectEntry,
} from '@/components/onboarding/steps/AgentsLogoMultiSelect';
import { WebDesktopDownloadCta } from '@/components/onboarding/steps/webDesktop/WebDesktopDownloadCta';
import { WizardTerminalHandoff } from '@/components/onboarding/ui/WizardTerminalHandoff';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ActionCard } from '@/components/ui/cards/ActionCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { Modal } from '@/modal';
import { useMachine } from '@/sync/domains/state/storage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
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
import { Icon } from '@/components/ui/icons/Icon';

function supportsDirectAgentSetup(agentId: AgentId | null | undefined): agentId is AgentId {
    return isBundledAgentId(agentId) && Boolean(getAgentCliRuntimeSpec(agentId).binaryName);
}

const DEFAULT_AGENT_IDS = AGENT_IDS.filter((agentId) => supportsDirectAgentSetup(agentId));
const DEFAULT_AGENT_ENTRIES = getResolvedAgentCatalogEntries({
    enabledAgentIds: DEFAULT_AGENT_IDS,
}).filter((entry) => supportsDirectAgentSetup(entry.catalogAgentId));

export type AgentSetupEntry = ResolvedAgentCatalogEntry;

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

function buildSelectableProviderEntries(entries: readonly AgentSetupEntry[], scope: Readonly<{
    machineId: string | null;
    serverId: string | null;
    current: boolean;
    color: string;
}>): AgentsLogoMultiSelectEntry[] {
    return entries.map((entry) => ({
        agentId: entry.agentId,
        setupAgentId: entry.catalogAgentId ?? null,
        icon: (
            <AgentCatalogIdentityIcon
                entry={entry}
                machineId={scope.machineId}
                serverId={scope.serverId}
                current={scope.current}
                color={scope.color}
                size={22}
            />
        ),
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
    projectionCurrent: boolean;
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
                    agentEntries={buildSelectableProviderEntries(agentEntries, {
                        machineId: null,
                        serverId: null,
                        current: props.projectionCurrent,
                        color: theme.colors.text.secondary,
                    })}
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

function areSetupExecutionTargetsEqual(
    left: Readonly<{ machineId: string; serverId: string }>,
    right: Readonly<{ machineId: string; serverId: string }>,
): boolean {
    return left.machineId === right.machineId && left.serverId === right.serverId;
}

export const AgentSetupFlow = React.memo(function AgentSetupFlow(props: Readonly<{
    agentIds?: readonly AgentId[];
    agentEntries?: readonly AgentSetupEntry[];
    machineId?: string | null;
    serverId?: string | null;
    projectionCurrent?: boolean;
    presentation?: 'settings' | 'wizard';
    onWizardPrimaryChange?: ((state: Readonly<{ label: string; disabled: boolean; onPress: () => void | Promise<void> }> | null) => void) | null;
    onRequestAdvance?: (() => void) | null;
}>) {
    const presentation = props.presentation ?? 'settings';
    const supportsDesktopControls = isDesktopHost();
    const agentEntries = React.useMemo(
        () => {
            const sourceEntries = props.agentEntries?.length
                ? props.agentEntries
                : props.agentIds?.length
                    ? (() => {
                        const requestedAgentIds = new Set<AgentId>(props.agentIds);
                        return getResolvedAgentCatalogEntries({ enabledAgentIds: props.agentIds })
                            .filter((entry) => entry.catalogAgentId !== null && requestedAgentIds.has(entry.catalogAgentId));
                    })()
                    : DEFAULT_AGENT_ENTRIES;
            return uniqueAgentSetupEntries(sourceEntries);
        },
        [props.agentEntries, props.agentIds],
    );
    if (!supportsDesktopControls && presentation === 'wizard') {
        return (
            <AgentSetupFlowWizardWebHandoff
                agentEntries={agentEntries.length > 0 ? agentEntries : DEFAULT_AGENT_ENTRIES}
                projectionCurrent={props.projectionCurrent === true}
            />
        );
    }

    const { theme } = useUnistyles();
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents,
    );
    const hasExplicitTarget = props.machineId !== undefined || props.serverId !== undefined;
    const resolveSetupExecutionTarget = React.useCallback(() => {
        if (hasExplicitTarget) {
            const machineId = typeof props.machineId === 'string' && props.machineId.trim()
                ? props.machineId.trim()
                : null;
            const serverId = typeof props.serverId === 'string' && props.serverId.trim()
                ? props.serverId.trim()
                : null;
            return machineId && serverId ? { machineId, serverId } : null;
        }
        const current = administrationTargetSelection.resolveExecutionTarget();
        return current ? { machineId: current.machine.id, serverId: current.serverId } : null;
    }, [administrationTargetSelection, hasExplicitTarget, props.machineId, props.serverId]);
    const executionTarget = resolveSetupExecutionTarget();
    const machineId = executionTarget?.machineId ?? null;
    const serverId = executionTarget?.serverId ?? null;
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
            const detectKey = getAgentCore(agentId)?.cli.detectKey;
            if (detectKey) out[agentId] = detectKey;
        }
        return out;
    }, [selectedSetupProviderIds]);
    const installQueue = useAgentCliInstallQueue({
        machineId,
        serverId,
        resolveExecutionTarget: resolveSetupExecutionTarget,
        agentIds: selectedSetupProviderIds,
        agentDetectKeys,
        installedByAgentId: cliAvailability.available,
    });
    const resetInstallQueue = installQueue.reset;
    const executionScopeKey = executionTarget
        ? `${executionTarget.serverId}\0${executionTarget.machineId}`
        : null;

    React.useEffect(() => {
        resetInstallQueue();
        setQueueState(null);
        setTerminalProviderId(null);
    }, [executionScopeKey, resetInstallQueue]);

    const toggleAgent = React.useCallback((agentId: string) => {
        if (queueState || installQueue.state.hasStarted) return;
        setSelectedAgentIds((previous) => {
            if (previous.includes(agentId)) {
                return previous.filter((entry) => entry !== agentId);
            }
            return [...previous, agentId];
        });
    }, [installQueue.state.hasStarted, queueState]);

    const canStart = selectedAgentIds.length > 0
        && hasRunnableSelectedProviders
        && executionTarget !== null
        && !installQueue.state.isRunning;
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

        const initialExecutionTarget = resolveSetupExecutionTarget();
        if (!initialExecutionTarget) return;

        const selectedEntries = agentEntries.filter((entry) => selectedAgentIds.includes(entry.agentId));
        const summary = await installQueue.start(uniqueSetupProviderIds(selectedEntries));
        const currentExecutionTarget = resolveSetupExecutionTarget();
        if (!currentExecutionTarget || !areSetupExecutionTargetsEqual(currentExecutionTarget, initialExecutionTarget)) return;
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
    }, [agentEntries, canStart, installQueue, resolveSetupExecutionTarget, selectedAgentIds]);

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
            {!hasExplicitTarget ? (
                <MachineAdministrationTargetSelector
                    selection={administrationTargetSelection}
                    testIDPrefix="settings.agents.setup.administration.target"
                />
            ) : null}
            {isWizardPresentation ? (
                <View style={{ gap: 12, alignItems: 'center' }}>
                    <AgentsLogoMultiSelect
                        testID="provider-setup-wizard-select"
                        agentEntries={buildSelectableProviderEntries(agentEntries, {
                            machineId,
                            serverId,
                            current: props.projectionCurrent === true,
                            color: theme.colors.text.secondary,
                        })}
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
                                icon={(
                                    <AgentCatalogIdentityIcon
                                        entry={entry}
                                        machineId={machineId}
                                        serverId={serverId}
                                        current={props.projectionCurrent === true}
                                        color={theme.colors.text.secondary}
                                        size={24}
                                    />
                                )}
                                rightElement={
                                    installQueue.state.hasStarted
                                        ? installStatus === 'installing'
                                            ? <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                            : installStatus === 'installed'
                                                ? <Icon name="check-circle" size={20} color={theme.colors.accent.blue} />
                                                : installStatus === 'failed'
                                                    ? <Icon name="warning-circle" size={20} color={theme.colors.text.secondary} />
                                                    : installStatus === 'queued'
                                                        ? <Icon name="clock" size={20} color={theme.colors.text.secondary} />
                                                        : undefined
                                        : selected
                                            ? <Icon name="check-circle" size={20} color={theme.colors.accent.blue} />
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
                        return (
                            <>
                    {!isWizardPresentation ? (
                        <ItemGroup title={t('settingsAgents.setup.queueTitle')}>
                            <Item
                                testID={`provider-setup-active-${activeProviderId}`}
                                title={activeEntry.title}
                                subtitle={t('settingsAgents.setup.activeDescription')}
                                icon={(
                                    <AgentCatalogIdentityIcon
                                        entry={activeEntry}
                                        machineId={machineId}
                                        serverId={serverId}
                                        current={props.projectionCurrent === true}
                                        color={theme.colors.accent.blue}
                                        size={24}
                                    />
                                )}
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
                            <AgentCatalogIdentityIcon
                                entry={activeEntry}
                                machineId={machineId}
                                serverId={serverId}
                                current={props.projectionCurrent === true}
                                color={theme.colors.accent.blue}
                                size={24}
                            />
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
                            if (!resolveSetupExecutionTarget()) return;
                            cliAvailability.refresh({
                                bypassCache: true,
                                includeLoginStatusForAgentIds: [activeSetupProviderId],
                            });
                        }}
                        onLaunchLogin={() => {
                            if (!supportsDesktopControls) return;
                            if (!resolveSetupExecutionTarget()) return;
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
                                    if (!resolveSetupExecutionTarget()) return;
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
                        return (
                            <View key={entry.agentId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                <AgentCatalogIdentityIcon
                                    entry={entry}
                                    machineId={machineId}
                                    serverId={serverId}
                                    current={props.projectionCurrent === true}
                                    color={theme.colors.text.secondary}
                                    size={20}
                                />
                                <View style={{ flex: 1, gap: 2 }}>
                                    <Text>{entry.title}</Text>
                                    <Text style={{ color: theme.colors.text.secondary }}>
                                        {buildInstallStepDetail(status) ?? t('settingsNotifications.badges.queuedTitle')}
                                    </Text>
                                </View>
                                {status === 'installing' ? (
                                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                ) : status === 'installed' ? (
                                    <Icon name="check-circle" size={20} color={theme.colors.accent.blue} />
                                ) : status === 'failed' ? (
                                    <Icon name="warning-circle" size={20} color={theme.colors.text.secondary} />
                                ) : status === 'queued' ? (
                                    <Icon name="clock" size={20} color={theme.colors.text.secondary} />
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
