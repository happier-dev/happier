import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { getProviderLocalAuthPlugin } from '@/agents/providers/catalog/providerLocalAuthCatalog';
import { AGENT_IDS, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import {
    ProvidersLogoMultiSelect,
    WizardTerminalHandoff,
    WebDesktopDownloadCta,
    type ProvidersLogoMultiSelectEntry,
} from '@/components/onboarding';
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
import { ProviderAuthenticationCard } from '../authentication/ProviderAuthenticationCard';
import { ProviderAuthenticationTerminalPane } from '../authentication/ProviderAuthenticationTerminalPane';
import { useProviderAuthenticationState } from '../authentication/useProviderAuthenticationState';
import {
    buildCliInstallAndRunCommandForCurrentApp,
    buildCliInstallAndRunPowershellCommandForCurrentApp,
} from '@/components/onboarding/commands/wizardCliCommands';
import { buildProviderSetupWizardPrimaryOverride } from './resolveProviderSetupWizardPrimaryOverride';
import {
    completeActiveProviderSetupStep,
    createProviderSetupQueueStateFromInstallSummary,
    skipActiveProviderSetupStep,
    type ProviderSetupQueueState,
} from './providerSetupQueue';
import { useProviderCliInstallQueue, type ProviderCliInstallStatus } from './useProviderCliInstallQueue';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

function supportsDirectProviderSetup(providerId: AgentId | null | undefined): providerId is AgentId {
    return isAgentId(providerId) && Boolean(getAgentCliRuntimeSpec(providerId).binaryName);
}

const DEFAULT_PROVIDER_IDS = AGENT_IDS.filter((providerId) => supportsDirectProviderSetup(providerId));
const DEFAULT_PROVIDER_ENTRIES = DEFAULT_PROVIDER_IDS.map((providerId) => {
    const core = getAgentCore(providerId);
    return {
        providerId,
        providerAgentId: providerId,
        title: t(core.displayNameKey),
        iconAgentId: providerId,
        iconName: core.ui.agentPickerIconName,
    } as const;
});

export type ProviderSetupEntry = Readonly<{
    providerId: string;
    providerAgentId?: AgentId | null;
    title: string;
    iconAgentId?: AgentId | null;
    iconName: string;
    subtitle?: string | null;
}>;

function uniqueProviderSetupEntries(entries: readonly ProviderSetupEntry[]): ProviderSetupEntry[] {
    const entriesById = new Map<string, ProviderSetupEntry>();
    for (const entry of entries) {
        if (!entry.providerId.trim()) continue;
        if (!entriesById.has(entry.providerId)) {
            entriesById.set(entry.providerId, entry);
        }
    }
    return [...entriesById.values()];
}

function buildSelectableProviderEntries(entries: readonly ProviderSetupEntry[]): ProvidersLogoMultiSelectEntry[] {
    return entries.map((entry) => ({
        providerId: entry.providerId,
        iconAgentId: entry.iconAgentId ?? null,
        setupProviderId: entry.providerAgentId ?? null,
        iconName: entry.iconName,
    }));
}

function uniqueSetupProviderIds(entries: readonly ProviderSetupEntry[]): AgentId[] {
    return [
        ...new Set(
            entries
                .map((entry) => entry.providerAgentId)
                .filter((providerId): providerId is AgentId => supportsDirectProviderSetup(providerId)),
        ),
    ];
}

const ProviderSetupFlowWizardWebHandoff = React.memo(function ProviderSetupFlowWizardWebHandoff(props: Readonly<{
    providerEntries: readonly ProviderSetupEntry[];
}>) {
    const { theme } = useUnistyles();
    const providerEntries = React.useMemo(() => props.providerEntries, [props.providerEntries]);
    const [selectedProviderIds, setSelectedProviderIds] = React.useState<string[]>(() => providerEntries.map((entry) => entry.providerId));

    React.useEffect(() => {
        setSelectedProviderIds((previous) => {
            const next = providerEntries.map((entry) => entry.providerId).filter((providerId) => previous.includes(providerId));
            return next.length > 0 ? next : providerEntries.map((entry) => entry.providerId);
        });
    }, [providerEntries]);

    const toggleProvider = React.useCallback((providerId: string) => {
        setSelectedProviderIds((previous) => {
            if (previous.includes(providerId)) {
                return previous.filter((entry) => entry !== providerId);
            }
            return [...previous, providerId];
        });
    }, []);

    const selectedSetupProviderIds = React.useMemo(
        () => uniqueSetupProviderIds(providerEntries.filter((entry) => selectedProviderIds.includes(entry.providerId))),
        [providerEntries, selectedProviderIds],
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
                <ProvidersLogoMultiSelect
                    testID="provider-setup-wizard-select"
                    providerEntries={buildSelectableProviderEntries(providerEntries)}
                    selectedProviderIds={selectedProviderIds}
                    onToggleProvider={toggleProvider}
                />
                <Text style={{ color: theme.colors.text.secondary, textAlign: 'center' }}>
                    {t('settingsProviders.setup.selectionFooter')}
                </Text>
            </View>
            {canLaunchSetupHandoff ? (
                <WizardTerminalHandoff
                    testID="provider-setup-wizard-terminal"
                    steps={[
                        {
                            title: t('settingsProviders.setup.startTitle'),
                            subtitle: t('settingsProviders.setup.startDescription'),
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
    providerId: string;
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
    providerEntries?: readonly ProviderSetupEntry[];
    machineId?: string | null;
    serverId?: string | null;
    presentation?: 'settings' | 'wizard';
    onWizardPrimaryChange?: ((state: Readonly<{ label: string; disabled: boolean; onPress: () => void | Promise<void> }> | null) => void) | null;
    onRequestAdvance?: (() => void) | null;
}>) {
    const presentation = props.presentation ?? 'settings';
    const supportsDesktopControls = isTauriDesktop();
    const providerEntries = React.useMemo(
        () => {
            const sourceEntries = props.providerEntries?.length
                ? props.providerEntries
                : (props.providerIds?.length ? props.providerIds : DEFAULT_PROVIDER_IDS).map((providerId) => {
                    const core = getAgentCore(providerId);
                    return {
                        providerId,
                        providerAgentId: providerId,
                        title: t(core.displayNameKey),
                        iconAgentId: providerId,
                        iconName: core.ui.agentPickerIconName,
                    } satisfies ProviderSetupEntry;
                });
            return uniqueProviderSetupEntries(sourceEntries);
        },
        [props.providerEntries, props.providerIds],
    );
    if (!supportsDesktopControls && presentation === 'wizard') {
        return <ProviderSetupFlowWizardWebHandoff providerEntries={providerEntries.length > 0 ? providerEntries : DEFAULT_PROVIDER_ENTRIES} />;
    }

    const { theme } = useUnistyles();
    const defaultMachineId = usePrimaryMachineFromActiveSelection();
    const serverId = props.serverId ?? getActiveServerId();
    const machineId = props.machineId ?? defaultMachineId;
    const machine = useMachine(machineId ?? '');
    const machineLabel = machine?.metadata?.displayName ?? machine?.metadata?.host ?? machineId ?? t('machine.detectedCliUnknown');
    const isWizardPresentation = presentation === 'wizard';

    const [selectedProviderIds, setSelectedProviderIds] = React.useState<string[]>(() => providerEntries.map((entry) => entry.providerId));
    const [queueState, setQueueState] = React.useState<ProviderSetupQueueState | null>(null);
    const [terminalProviderId, setTerminalProviderId] = React.useState<string | null>(null);

    React.useEffect(() => {
        setSelectedProviderIds((previous) => {
            const next = providerEntries.map((entry) => entry.providerId).filter((providerId) => previous.includes(providerId));
            return next.length > 0 ? next : providerEntries.map((entry) => entry.providerId);
        });
    }, [providerEntries]);

    const activeProviderId = queueState?.activeProviderId ?? null;
    const activeEntry = React.useMemo(
        () => providerEntries.find((entry) => entry.providerId === activeProviderId) ?? null,
        [activeProviderId, providerEntries],
    );
    const activeSetupProviderId = activeEntry?.providerAgentId ?? null;
    const activeCore = activeSetupProviderId ? getAgentCore(activeSetupProviderId) : null;
    const authPlugin = activeSetupProviderId ? getProviderLocalAuthPlugin(activeSetupProviderId) : null;
    const selectedSetupProviderIds = React.useMemo(
        () => uniqueSetupProviderIds(providerEntries.filter((entry) => selectedProviderIds.includes(entry.providerId))),
        [providerEntries, selectedProviderIds],
    );
    const hasRunnableSelectedProviders = selectedSetupProviderIds.length > 0;
    const cliAvailability = useCLIDetection(machineId, {
        autoDetect: Boolean(machineId),
        agentIds: selectedSetupProviderIds,
        includeLoginStatus: Boolean(activeSetupProviderId),
        includeLoginStatusForAgentIds: activeSetupProviderId ? [activeSetupProviderId] : [],
        serverId,
    });
    const authState = useProviderAuthenticationState({
        providerId: activeSetupProviderId,
        cliAvailability,
        authPlugin,
        primaryMachine: machine ?? null,
    });
    const providerDetectKeys = React.useMemo(() => {
        const out: Partial<Record<AgentId, string>> = {};
        for (const providerId of selectedSetupProviderIds) {
            out[providerId] = getAgentCore(providerId).cli.detectKey;
        }
        return out;
    }, [selectedSetupProviderIds]);
    const installQueue = useProviderCliInstallQueue({
        machineId,
        serverId,
        providerIds: selectedSetupProviderIds,
        providerDetectKeys,
        installedByProviderId: cliAvailability.available,
    });

    const toggleProvider = React.useCallback((providerId: string) => {
        if (queueState || installQueue.state.hasStarted) return;
        setSelectedProviderIds((previous) => {
            if (previous.includes(providerId)) {
                return previous.filter((entry) => entry !== providerId);
            }
            return [...previous, providerId];
        });
    }, [installQueue.state.hasStarted, queueState]);

    const canStart = selectedProviderIds.length > 0 && hasRunnableSelectedProviders && Boolean(machineId) && !installQueue.state.isRunning;
    const isFinished = queueState != null && queueState.activeProviderId == null;

    const startSetup = React.useCallback(async () => {
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

        const selectedEntries = providerEntries.filter((entry) => selectedProviderIds.includes(entry.providerId));
        const summary = await installQueue.start(uniqueSetupProviderIds(selectedEntries));
        const installedProviderIdSet = new Set(summary.installedProviderIds);
        const failedProviderIdSet = new Set(summary.failedProviderIds);
        setQueueState(createProviderSetupQueueStateFromInstallSummary({
            selectedProviderIds: selectedEntries.map((entry) => entry.providerId),
            installedProviderIds: selectedEntries
                .filter((entry) => entry.providerAgentId != null && installedProviderIdSet.has(entry.providerAgentId))
                .map((entry) => entry.providerId),
            failedProviderIds: selectedEntries
                .filter((entry) => entry.providerAgentId != null && failedProviderIdSet.has(entry.providerAgentId))
                .map((entry) => entry.providerId),
        }));
    }, [canStart, installQueue, providerEntries, selectedProviderIds]);

    const continueQueue = React.useCallback(() => {
        setTerminalProviderId(null);
        setQueueState((current) => (current ? completeActiveProviderSetupStep(current) : current));
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

        const override = buildProviderSetupWizardPrimaryOverride({
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
                    <ProvidersLogoMultiSelect
                        testID="provider-setup-wizard-select"
                        providerEntries={buildSelectableProviderEntries(providerEntries)}
                        selectedProviderIds={selectedProviderIds}
                        onToggleProvider={toggleProvider}
                    />
                    <Text style={{ color: theme.colors.text.secondary, textAlign: 'center' }}>
                        {t('settingsProviders.setup.selectionFooter')}
                    </Text>
                </View>
            ) : (
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
                    {providerEntries.map((entry) => {
                        const selected = selectedProviderIds.includes(entry.providerId);
                        const stepState = resolveProviderStepState({ providerId: entry.providerId, queueState });
                        const installStatus = entry.providerAgentId ? installQueue.resolveStatus(entry.providerAgentId).status : 'idle';
                        const iconName = entry.iconAgentId ? getAgentCore(entry.iconAgentId).ui.agentPickerIconName : entry.iconName;
                        const canRetryInstall = installQueue.state.hasStarted && !installQueue.state.isRunning && installStatus === 'failed';
                        return (
                            <Item
                                key={entry.providerId}
                                testID={`provider-setup-option-${entry.providerId}`}
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
                                        if (canRetryInstall && entry.providerAgentId) {
                                            await installQueue.retry(entry.providerAgentId);
                                        }
                                        return;
                                    }
                                    toggleProvider(entry.providerId);
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {!isWizardPresentation && !queueState && !installQueue.state.hasStarted ? (
                <ActionCard
                    testID="provider-setup-start-card"
                    title={t('settingsProviders.setup.startTitle')}
                    description={t('settingsProviders.setup.startDescription')}
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
                        <ItemGroup title={t('settingsProviders.setup.queueTitle')}>
                            <Item
                                testID={`provider-setup-active-${activeProviderId}`}
                                title={activeEntry.title}
                                subtitle={t('settingsProviders.setup.activeDescription')}
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
                                    {t('settingsProviders.setup.activeDescription')}
                                </Text>
                            </View>
                        </View>
                    ) : null}
                            </>
                        );
                    })()}
                    <ProviderAuthenticationCard
                        providerId={activeEntry.providerId}
                        runtimeProviderId={activeSetupProviderId}
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
                            <ProviderAuthenticationTerminalPane
                                providerId={activeSetupProviderId}
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
                            title={t('settingsProviders.setup.queueTitle')}
                            description={t('settingsProviders.setup.queueDescription', { provider: activeEntry.title })}
                            primaryAction={{
                                label: (queueState?.pendingProviderIds.length ?? 0) > 0 ? t('common.continue') : t('common.done'),
                                onPress: continueQueue,
                            }}
                            secondaryAction={{
                                label: t('settingsProviders.setup.skipAction'),
                                onPress: () => {
                                    setTerminalProviderId(null);
                                    setQueueState((current) => (current ? skipActiveProviderSetupStep(current) : current));
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
                                setQueueState((current) => (current ? skipActiveProviderSetupStep(current) : current));
                            }}
                        >
                            {t('settingsProviders.setup.skipAction')}
                        </Text>
                    )}
                </>
            ) : null}

            {!isWizardPresentation && isFinished ? (
                <ActionCard
                    testID="provider-setup-complete-card"
                    title={t('settingsProviders.setup.completedTitle')}
                    description={t('settingsProviders.setup.completedDescription')}
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
                    {providerEntries.map((entry) => {
                        const selected = selectedProviderIds.includes(entry.providerId);
                        if (!selected) return null;

                        const status = entry.providerAgentId ? installQueue.resolveStatus(entry.providerAgentId).status : 'idle';
                        const iconName = entry.iconAgentId ? getAgentCore(entry.iconAgentId).ui.agentPickerIconName : entry.iconName;
                        return (
                            <View key={entry.providerId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
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
                    {t('settingsProviders.setup.completedDescription')}
                </Text>
            ) : null}
        </View>
    );
});
