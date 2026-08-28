import React from 'react';
import { View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { BadgeGrid, type BadgeGridItem } from '@/components/ui/layout/BadgeGrid';
import { useSettings } from '@/sync/domains/state/storage';
import { useApplySettings } from '@/sync/store/settingsWriters';
import {
    resolveBundledAgentIdFromContributionIdentity,
} from '@/agents/catalog/catalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    getResolvedAgentCatalogEntries,
    resolveAgentCatalogProjection,
    type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import { t } from '@/text';
import {
    readCurrentProjectedAgentCapabilities,
    supportsCurrentProjectedAgentSessionOpen,
    supportsCurrentProjectedAgentSurface,
    type CurrentProjectedAgentCapabilities,
} from '@/agents/backendCatalog/currentAgentCapabilities';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { useCapabilityInstallability } from '@/hooks/machine/useCapabilityInstallability';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import { AgentCliInstallItem } from '@/components/settings/agents/AgentCliInstallItem';
import { resolveAgentChannelLabelKey } from '@/components/settings/agents/agentChannelLabel';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { AgentAuthenticationCard } from '@/components/settings/agents/authentication/AgentAuthenticationCard';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { AgentAuthenticationTerminalPane } from '@/components/settings/agents/authentication/AgentAuthenticationTerminalPane';
import { scheduleAgentAuthenticationRefreshes } from '@/components/settings/agents/authentication/scheduleAgentAuthenticationRefreshes';
import { useAgentAuthenticationState } from '@/components/settings/agents/authentication/useAgentAuthenticationState';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import {
    PluginContributionIdentityV1Schema,
    QualifiedConnectedAccountPurposeBindingsV1Schema,
    qualifiedPurposeKey,
    type PluginProjectedAgentConnectedAccountPurposeV2,
    type QualifiedConnectedAccountPurposeBindingTargetV1,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import {
    getAgentBackendCompatibilityTargetKeys,
    readBackendTargetSettingValue,
} from '@/agents/backendCatalog/backendTargetEnablement';
import { PluginDetailGenericSettingsSection } from '@/components/settings/plugins/detail/PluginDetailGenericSettingsSection';
import type { ScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import { AgentDetailExternalSessionsSection } from '@/components/settings/externalSessions/AgentDetailExternalSessionsSection';
import type {
    ExternalSessionsQualifiedAgent,
} from '@/components/settings/externalSessions/externalSessionsIntegrationModel';
import { Icon } from '@/components/ui/icons/Icon';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import {
    useMachineAdministrationTargetSelection,
    type FreshMachineAdministrationExecutionTargetV1,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { isAdministrationScopedPluginSettingsTargetCurrent } from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

function resolveExternalSessionsAgentBinding(
    projection: PluginProjectionV2 | null | undefined,
    agentId: string,
    qualifiedAgent?: ExternalSessionsQualifiedAgent | null,
): Readonly<{
    agent: ExternalSessionsQualifiedAgent;
    generation: number;
    browseAvailable: boolean;
}> | null {
    if (!projection || !projection.agentsById[agentId]) return null;

    const externalSessions = projection.agentsById[agentId]?.externalSessions;
    if (externalSessions?.generation === projection.generation) {
        return {
            agent: externalSessions.agent,
            generation: externalSessions.generation,
            browseAvailable: true,
        };
    }

    const candidates: ExternalSessionsQualifiedAgent[] = [];
    for (const record of projection.contributionIntrospection?.contributions ?? []) {
        const contribution = record.contribution;
        if (
            record.progression.merged
            && record.projection.state === 'projected'
            && contribution.kind === 'localId'
            && contribution.family === 'agents'
            && (
                qualifiedAgent
                    ? contribution.pluginId === qualifiedAgent.pluginId
                        && contribution.localId === qualifiedAgent.localId
                    : contribution.localId === agentId
            )
        ) {
            candidates.push({
                pluginId: contribution.pluginId,
                localId: contribution.localId,
            });
        }
    }
    const uniqueCandidates = [...new Map(
        candidates.map((candidate) => [
            `${candidate.pluginId}\u0000${candidate.localId}`,
            candidate,
        ]),
    ).values()];
    if (uniqueCandidates.length !== 1) return null;

    return {
        agent: uniqueCandidates[0]!,
        generation: projection.generation,
        browseAvailable: false,
    };
}

function resolveQualifiedAgentProjectionId(params: Readonly<{
    routeAgent: ExternalSessionsQualifiedAgent | null;
    fallbackAgentId: string;
    mergedProviderProjectionById:
        Readonly<Record<string, Readonly<{
            identity?: Readonly<{ pluginId: string; localId: string }> | null;
        }>>> | null | undefined;
}>): string | null {
    if (!params.routeAgent) return params.fallbackAgentId;

    const matches = Object.entries(params.mergedProviderProjectionById ?? {})
        .filter(([, entry]) => (
            entry.identity?.pluginId === params.routeAgent?.pluginId
            && entry.identity?.localId === params.routeAgent?.localId
        ))
        .map(([agentId]) => agentId);
    if (matches.length === 1) return matches[0] ?? null;
    if (matches.length > 1) return null;

    return resolveBundledAgentIdFromContributionIdentity(params.routeAgent);
}

function resolveLegacyCompatAgentRouteRedirect(params: Readonly<{
    agentId: string;
    daemonMergedProjectionInputs?: {
        mergedProviderProjectionById?: Readonly<Record<string, unknown>> | null;
        mergedBackendProjectionById?: Readonly<Record<string, { agentId?: unknown }>> | null;
    } | null;
}>): string | null {
    if (!isLegacyCompatAgentType(params.agentId)) {
        return null;
    }

    const agentIds = new Set<string>();
    for (const agentId of Object.keys(params.daemonMergedProjectionInputs?.mergedProviderProjectionById ?? {})) {
        const normalizedAgentId = agentId.trim();
        if (!normalizedAgentId || isLegacyCompatAgentType(normalizedAgentId)) {
            continue;
        }
        agentIds.add(normalizedAgentId);
    }
    for (const projection of Object.values(params.daemonMergedProjectionInputs?.mergedBackendProjectionById ?? {})) {
        const normalizedAgentId = String(projection.agentId ?? '').trim();
        if (!normalizedAgentId || isLegacyCompatAgentType(normalizedAgentId)) {
            continue;
        }
        agentIds.add(normalizedAgentId);
    }

    return agentIds.size === 1 ? [...agentIds][0] ?? null : null;
}

const AGENT_AUTH_TERMINAL_TAB_ID = 'agent-auth-terminal';

const AgentSettingsNotFound = React.memo(function AgentSettingsNotFound(props: Readonly<{
    theme: ReturnType<typeof useUnistyles>['theme'];
    targetSelection: MachineAdministrationTargetSelectionV1;
}>) {
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <MachineAdministrationTargetSelector
                selection={props.targetSelection}
                testIDPrefix="settings.agents.administration.target"
            />
            <ItemGroup>
                <View style={{ alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 }}>
                    <Icon name="warning" size={48} color={props.theme.colors.state.danger.foreground} style={{ marginBottom: 16 }} />
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 16, color: props.theme.colors.state.danger.foreground, textAlign: 'center', marginBottom: 8 }}>
                        {t('settingsAgents.notFoundTitle')}
                    </Text>
                    <Text style={{ ...Typography.default(), fontSize: 14, color: props.theme.colors.text.secondary, textAlign: 'center', lineHeight: 20 }}>
                        {t('settingsAgents.notFoundSubtitle')}
                    </Text>
                </View>
            </ItemGroup>
        </ItemList>
    );
});

/**
 * The Agent-targeted settings an installed plugin contributes, rendered through
 * the one canonical plugin settings section.
 *
 * Both Agent presentations reach it: the full Agent screen and the reduced
 * screen an Agent with no bundled runtime carrier and no CLI auth resolves to.
 * Without a single owner the reduced screen silently dropped the projection it
 * had already resolved, so an Agent that ships settings but no CLI had no way
 * to expose them.
 */
export const AgentContributedSettingsSection = React.memo(function AgentContributedSettingsSection(props: Readonly<{
    pluginSettingsProjection: PluginProjectionEntry | null;
    targetSelection: MachineAdministrationTargetSelectionV1;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    daemonOperationsAvailable: boolean;
}>) {
    const { pluginSettingsProjection, targetSelection, executionTarget, daemonOperationsAvailable } = props;
    const activeServer = useActiveServerSnapshot();
    const accountServerIdentityId = React.useMemo(
        () => resolveScopedPluginSettingsServerIdentity(activeServer.serverId),
        [activeServer.serverId],
    );
    const isDaemonSettingsTargetCurrent = React.useCallback((target: Extract<ScopedPluginSettingsTarget, { kind: 'daemon' }>) => {
        return isAdministrationScopedPluginSettingsTargetCurrent({
            target,
            expectedExecutionTarget: executionTarget,
            resolveCurrentExecutionTarget: targetSelection.resolveExecutionTarget,
        });
    }, [executionTarget, targetSelection.resolveExecutionTarget]);
    if (!pluginSettingsProjection) return null;
    return (
        <PluginDetailGenericSettingsSection
            pluginId={pluginSettingsProjection.pluginId}
            projection={pluginSettingsProjection}
            machineId={executionTarget?.machine.id ?? null}
            serverId={executionTarget?.serverId ?? null}
            accountServerIdentityId={accountServerIdentityId}
            daemonServerIdentityId={executionTarget?.target.serverIdentityId ?? null}
            perActiveServerIdentityId={targetSelection.selectedTarget?.serverIdentityId ?? null}
            daemonOperationsAvailable={daemonOperationsAvailable}
            isDaemonTargetCurrent={isDaemonSettingsTargetCurrent}
        />
    );
});

const AgentConnectedAccountPurposeSettingsSection = React.memo(function AgentConnectedAccountPurposeSettingsSection(
    props: Readonly<{ projection: ResolvedAgentCatalogEntry }>,
) {
    const settings = useSettings();
    const applySettings = useApplySettings();
    const identity = props.projection.identity;
    const declarations = props.projection.connectedAccounts ?? [];
    const targets = React.useMemo(() => new Map(
        settings.connectedAccountPurposeBindingsV1.bindings.map((binding) => [
            qualifiedPurposeKey(binding.purpose),
            binding.target,
        ] as const),
    ), [settings.connectedAccountPurposeBindingsV1]);
    const setTarget = React.useCallback((
        declaration: PluginProjectedAgentConnectedAccountPurposeV2,
        target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
    ) => {
        if (!identity) return;
        const purpose = { consumer: identity, purpose: declaration.purpose };
        const key = qualifiedPurposeKey(purpose);
        const retained = settings.connectedAccountPurposeBindingsV1.bindings.filter(
            (binding) => qualifiedPurposeKey(binding.purpose) !== key,
        );
        applySettings({
            connectedAccountPurposeBindingsV1: QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
                v: 1,
                bindings: target ? [...retained, { purpose, target }] : retained,
            }),
        });
    }, [applySettings, identity, settings.connectedAccountPurposeBindingsV1]);

    if (!identity || declarations.length === 0) return null;
    return (
        <ItemGroup
            title={t('connectedServices.defaultAuth.agentDetailTitle')}
            footer={t('connectedServices.defaultAuth.agentDetailFooter')}
        >
            {declarations.map((declaration) => {
                const purpose = { consumer: identity, purpose: declaration.purpose };
                const purposeKey = qualifiedPurposeKey(purpose);
                return (
                    <ConnectedAccountPurposeTargetChooser
                        key={purposeKey}
                        testID={`agent-connected-account-purpose:${declaration.purpose}`}
                        declaration={declaration}
                        value={targets.get(purposeKey) ?? null}
                        onChange={(target) => setTarget(declaration, target)}
                    />
                );
            })}
        </ItemGroup>
    );
});

const AgentSettingsFallbackScreenInner = React.memo(function AgentSettingsFallbackScreenInner(props: Readonly<{
    projection: ResolvedAgentCatalogEntry;
    pluginSettingsProjection: PluginProjectionEntry | null;
    targetSelection: MachineAdministrationTargetSelectionV1;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    daemonOperationsAvailable: boolean;
    externalSessionsProjectionPhase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    externalSessionsAgent: ExternalSessionsQualifiedAgent | null;
    externalSessionsBrowseAvailable: boolean;
    externalSessionsRefreshKey: string | null;
}>) {
    const { theme } = useUnistyles();
    const settings = useSettings();
    const applySettings = useApplySettings();
    const providerTargetKey = props.projection.backendTargetKey;
    const backendEnabledByTargetKey = settings.backendEnabledByTargetKey;
    const backendEnabled = props.projection.enabled;
    const setBackendEnabled = React.useCallback((next: boolean) => {
        if (!providerTargetKey) return;
        applySettings({
            backendEnabledByTargetKey: {
                ...(backendEnabledByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    }, [applySettings, backendEnabledByTargetKey, providerTargetKey]);
    const title = props.projection.title;
    const subtitle = props.projection.subtitle ?? props.projection.agentId;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <AgentContributedSettingsSection
                pluginSettingsProjection={props.pluginSettingsProjection}
                targetSelection={props.targetSelection}
                executionTarget={props.executionTarget}
                daemonOperationsAvailable={props.daemonOperationsAvailable}
            />
            {/*
              * External Sessions reachability belongs to the Agent, not to
              * whether it also carries a bundled runtime or a login screen:
              * Protocol admits an auxiliary-only Agent that declares only the
              * `externalSessions` surface, and that Agent lands here.
              */}
            <AgentDetailExternalSessionsSection
                agentId={props.projection.agentId}
                behaviorAgentId={props.projection.agentId}
                agentTitle={props.projection.title}
                machineId={props.executionTarget?.machine.id ?? null}
                daemonStateVersion={props.executionTarget?.machine.daemonStateVersion ?? null}
                serverId={props.executionTarget?.serverId ?? null}
                agent={props.externalSessionsAgent}
                browseAvailable={props.externalSessionsBrowseAvailable}
                refreshKey={props.externalSessionsRefreshKey}
                projectionPhase={props.externalSessionsProjectionPhase}
            />
            <AgentConnectedAccountPurposeSettingsSection projection={props.projection} />
            <ItemGroup title={title} footer={t('settingsAgents.footer')}>
                <Item
                    title={title}
                    subtitle={subtitle}
                    icon={(
                        <AgentCatalogIdentityIcon
                            entry={props.projection}
                            machineId={props.executionTarget?.machine.id ?? null}
                            serverId={props.executionTarget?.serverId ?? null}
                            current={props.daemonOperationsAvailable}
                            color={theme.colors.text.secondary}
                        />
                    )}
                    mode="info"
                />
                <Item
                    title={t('settingsAgents.enabledTitle')}
                    subtitle={t('settingsAgents.enabledSubtitle')}
                    icon={<Icon name="toggle-right" size={29} color={theme.colors.text.secondary} />}
                    rightElement={backendEnabled === null ? undefined : <Switch value={backendEnabled} onValueChange={setBackendEnabled} />}
                    showChevron={false}
                    onPress={() => {
                        if (backendEnabled === null) return;
                        setBackendEnabled(!backendEnabled);
                    }}
                />
            </ItemGroup>
            <ItemGroup title={t('settingsAgents.configuration')} footer={t('settingsAgents.notFoundSubtitle')}>
                <Item
                    title={props.projection.isBuiltIn ? t('settingsAgents.notAvailable') : props.projection.title}
                    subtitle={props.projection.isBuiltIn ? t('settingsAgents.notFoundSubtitle') : subtitle}
                    icon={<Icon name="info" size={29} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            </ItemGroup>
        </ItemList>
    );
});

const AgentSettingsScreenInner = React.memo(function AgentSettingsScreenInner(props: Readonly<{
    agentId: string;
    cliAgentId: string | null;
    projection: ResolvedAgentCatalogEntry;
    currentAgentCapabilities: CurrentProjectedAgentCapabilities | null;
    authPlugin: ResolvedAgentCatalogEntry['authPlugin'];
    targetSelection: MachineAdministrationTargetSelectionV1;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    compatibilityTargetKeys: readonly string[];
    pluginSettingsProjection: PluginProjectionEntry | null;
    daemonOperationsAvailable: boolean;
    externalSessionsProjectionPhase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    externalSessionsAgent: ExternalSessionsQualifiedAgent | null;
    externalSessionsBrowseAvailable: boolean;
    externalSessionsRefreshKey: string | null;
    installIntent?: 'install' | 'update';
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const supportsDesktopControls = isDesktopHost();
    const {
        agentId,
        cliAgentId,
        projection,
        currentAgentCapabilities,
        authPlugin,
        targetSelection,
        executionTarget,
        compatibilityTargetKeys,
        pluginSettingsProjection,
        daemonOperationsAvailable,
        externalSessionsProjectionPhase,
        externalSessionsAgent,
        externalSessionsBrowseAvailable,
        externalSessionsRefreshKey,
        installIntent,
    } = props;
    const settings = useSettings();
    const paneScopeId = React.useMemo(
        () => `settings:provider:${agentId}`,
        [agentId],
    );
    const pane = useAppPaneScope(paneScopeId);
    const applySettings = useApplySettings();

    const popoverBoundaryRef = React.useRef<any>(null);
    const [openMenu, setOpenMenu] = React.useState<null | string>(null);

    const agentCli = projection.cli;
    const providerTargetKey = projection.backendTargetKey;
    const backendEnabledByTargetKey = settings.backendEnabledByTargetKey;
    const backendEnabled = projection.enabled;
    const setBackendEnabled = (next: boolean) => {
        if (!providerTargetKey) return;
        applySettings({
            backendEnabledByTargetKey: {
                ...(backendEnabledByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };

    const defaultPermissionByTargetKey = settings.sessionDefaultPermissionModeByTargetKey;
    const permissionModeOptions = getPermissionModeOptionsForAgentType(projection.agentId);
    const permissionMode = providerTargetKey
        ? (
            readBackendTargetSettingValue({
                valuesByTargetKey: defaultPermissionByTargetKey,
                canonicalTargetKey: providerTargetKey,
                compatibilityTargetKeys,
            }) ?? 'default'
        )
        : 'default';
    const setPermissionMode = (next: PermissionMode) => {
        if (!providerTargetKey) return;
        applySettings({
            sessionDefaultPermissionModeByTargetKey: {
                ...(defaultPermissionByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };

    const backendCliSourcePreferenceByTargetKey = settings.backendCliSourcePreferenceByTargetKey;
    const providerCliSourcePreference =
        providerTargetKey && agentCli
            ? (
                readBackendTargetSettingValue({
                    valuesByTargetKey: backendCliSourcePreferenceByTargetKey,
                    canonicalTargetKey: providerTargetKey,
                    compatibilityTargetKeys,
                }) ?? agentCli.executable.sourcePreference
            )
            : 'system-first';
    const setProviderCliSourcePreference = (next: 'system-first' | 'managed-first') => {
        if (!providerTargetKey) return;
        applySettings({
            backendCliSourcePreferenceByTargetKey: {
                ...(backendCliSourcePreferenceByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };

    const supportsResume = supportsCurrentProjectedAgentSessionOpen(currentAgentCapabilities, 'resume');
    const supportsTerminal = supportsCurrentProjectedAgentSurface(currentAgentCapabilities, 'terminal');
    const installInfo = agentCli?.install.guideUrl
        ?? agentCli?.install.docsUrl
        ?? (agentCli ? t('settingsAgents.installInfoUseAgentCliInstaller') : t('settingsAgents.notAvailable'));

    const primaryMachine = executionTarget?.machine ?? null;
    const capabilityServerId = executionTarget?.serverId ?? null;
    const resolveCurrentExecutionTarget = React.useCallback(() => {
        if (!executionTarget) return null;
        const resolvedTarget = targetSelection.resolveExecutionTarget();
        if (!resolvedTarget || !isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: executionTarget,
            resolveCurrentTarget: () => resolvedTarget,
        })) return null;
        return {
            machineId: resolvedTarget.machine.id,
            serverId: resolvedTarget.serverId,
        };
    }, [executionTarget, targetSelection]);
    const automaticLoginStatusAgentIds = React.useMemo(
        () => (cliAgentId && projection.cliAuthBackgroundCheckSafe ? [cliAgentId] : []),
        [cliAgentId, projection.cliAuthBackgroundCheckSafe],
    );
    const cliAvailability = useCLIDetection(primaryMachine?.id ?? null, {
        autoDetect: primaryMachine !== null && (projection.isBuiltIn || daemonOperationsAvailable),
        agentIds: cliAgentId ? [cliAgentId] : [],
        includeLoginStatus: Boolean(cliAgentId),
        includeLoginStatusForAgentIds: automaticLoginStatusAgentIds,
        serverId: capabilityServerId,
    });
    const agentAuthentication = useAgentAuthenticationState({
        agentId: cliAgentId,
        cliAvailability,
        authPlugin,
        primaryMachine,
    });
    const providerCliAvailable = cliAgentId ? cliAvailability.available[cliAgentId] : null;
    const providerCliManagedInstalled = cliAgentId ? cliAvailability.resolutionSource[cliAgentId] === 'managed' : false;
    const providerCliCapabilityId = cliAgentId ? buildProviderCliCapabilityId(cliAgentId) : null;
    const cliInstallability = useCapabilityInstallability({
        machineId: primaryMachine?.id ?? null,
        serverId: capabilityServerId,
        capabilityId: providerCliCapabilityId,
        timeoutMs: 5000,
    });
    const primaryMachineLabel = primaryMachine?.metadata?.displayName ?? primaryMachine?.metadata?.host ?? primaryMachine?.id ?? null;
    const detectedCliStatus = providerCliAvailable === true
        ? t('machine.detectedCliDetected')
        : providerCliAvailable === false
            ? t('machine.detectedCliNotDetected')
            : cliAvailability.isDetecting
                ? t('common.loading')
                : t('machine.detectedCliUnknown');
    const installSetupSubtitle = cliInstallability.kind === 'checking'
        ? `${installInfo} • ${t('common.loading')}`
        : cliInstallability.kind === 'not-installable'
            ? `${installInfo} • ${t('settingsAgents.notAvailable')}`
            : installInfo;

    const statusIconName = providerCliAvailable === true
        ? 'checkmark-circle'
        : providerCliAvailable === false
            ? 'close-circle'
            : cliAvailability.isDetecting
                ? 'time-outline'
                : 'alert-circle';
    const statusIconColor = providerCliAvailable === true
        ? theme.colors.state.success.foreground
        : providerCliAvailable === false
            ? theme.colors.state.danger.foreground
            : theme.colors.text.secondary;

    const capabilityBadges: BadgeGridItem[] = [
        {
            id: 'resume',
            label: t('settingsAgents.resumeSupportTitle'),
            status: supportsResume ? 'positive' : 'negative',
            detail: supportsResume ? t('settingsAgents.resumeSupportSupported') : t('settingsAgents.resumeSupportNotSupported'),
        },
        {
            id: 'localControl',
            label: t('settingsAgents.localControlTitle'),
            status: supportsTerminal ? 'positive' : 'negative',
            detail: supportsTerminal ? t('settingsAgents.supported') : t('settingsAgents.notSupported'),
        },
    ];
    const authTerminalOpen =
        pane.scopeState?.bottom?.isOpen === true
        && pane.scopeState?.bottom?.activeTabId === AGENT_AUTH_TERMINAL_TAB_ID;
    const cancelPendingAuthRefreshesRef = React.useRef<(() => void) | null>(null);
    const triggerProviderAuthRefreshes = React.useCallback(() => {
        cancelPendingAuthRefreshesRef.current?.();
        cancelPendingAuthRefreshesRef.current = scheduleAgentAuthenticationRefreshes({
            refresh: () => {
                if (!cliAgentId || !resolveCurrentExecutionTarget()) return;
                cliAvailability.refresh({
                    bypassCache: true,
                    includeLoginStatusForAgentIds: [cliAgentId],
                });
            },
        });
    }, [cliAgentId, cliAvailability, resolveCurrentExecutionTarget]);
    const closeProviderAuthTerminal = React.useCallback(() => {
        pane.closeBottom();
        triggerProviderAuthRefreshes();
    }, [pane, triggerProviderAuthRefreshes]);
    const handleProviderAuthTerminalExit = React.useCallback(() => {
        closeProviderAuthTerminal();
    }, [closeProviderAuthTerminal]);
    React.useEffect(() => {
        return () => {
            cancelPendingAuthRefreshesRef.current?.();
            cancelPendingAuthRefreshesRef.current = null;
        };
    }, []);

    const main = (
        <ItemList style={{ paddingTop: 0 }}>
                <MachineAdministrationTargetSelector
                    selection={targetSelection}
                    testIDPrefix="settings.agents.administration.target"
                />
                <AgentContributedSettingsSection
                    pluginSettingsProjection={pluginSettingsProjection}
                    targetSelection={targetSelection}
                    executionTarget={executionTarget}
                    daemonOperationsAvailable={daemonOperationsAvailable}
                />
                <ItemGroup title={t('settingsAgents.configuration')} footer={projection.subtitle ?? t('settingsAgents.footer')}>
                <Item
                    title={projection.title}
                    subtitle={projection.subtitle ?? projection.agentId}
                    icon={(
                        <AgentCatalogIdentityIcon
                            entry={projection}
                            machineId={primaryMachine?.id ?? null}
                            serverId={capabilityServerId}
                            current={projection.identity
                                ? daemonOperationsAvailable
                                : projection.isBuiltIn || daemonOperationsAvailable}
                            color={theme.colors.text.secondary}
                        />
                    )}
                    mode="info"
                />
                <Item
                    title={primaryMachineLabel ? `${primaryMachineLabel} · ${detectedCliStatus}` : detectedCliStatus}
                    subtitle={t(resolveAgentChannelLabelKey(projection.channel))}
                    icon={<Icon name={statusIconName as any} size={29} color={statusIconColor} />}
                        mode="info"
                    />
                    {providerTargetKey ? (
                        <Item
                            title={t('settingsAgents.enabledTitle')}
                            subtitle={t('settingsAgents.enabledSubtitle')}
                            icon={<Icon name="toggle-right" size={29} color={theme.colors.text.secondary} />}
                            rightElement={<Switch value={backendEnabled ?? undefined} onValueChange={setBackendEnabled} />}
                            showChevron={false}
                            onPress={() => {
                                if (backendEnabled === null) return;
                                setBackendEnabled(!backendEnabled);
                            }}
                        />
                    ) : null}
                </ItemGroup>

                {providerTargetKey && permissionModeOptions.length > 0 ? (
                    <ItemGroup
                        title={t('settingsSession.permissions.title')}
                        footer={t('settingsSession.permissions.backendFooter')}
                    >
                        <DropdownMenu
                        open={openMenu === 'permissionMode'}
                        onOpenChange={(next) => setOpenMenu(next ? 'permissionMode' : null)}
                        variant="selectable"
                        search={false}
                        selectedId={permissionMode}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        popoverPortalWebTarget="body"
                        itemTrigger={{
                            title: t('settingsSession.permissions.defaultPermissionModeTitle'),
                            subtitle: getPermissionModeLabelForAgentType(projection.agentId, permissionMode),
                            icon: <Icon name="shield-check" size={29} color={theme.colors.state.success.foreground} />,
                        }}
                        items={permissionModeOptions.map((opt) => ({
                            id: opt.value,
                            title: opt.label,
                            subtitle: opt.description,
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Icon name={opt.icon as any} size={20} color={theme.colors.text.secondary} />
                                </View>
                            ),
                        }))}
                        onSelect={(id) => {
                            const nextMode = permissionModeOptions.find((opt) => opt.value === id)?.value;
                            if (nextMode) setPermissionMode(nextMode);
                            setOpenMenu(null);
                        }}
                    />
                    </ItemGroup>
                ) : null}

                <AgentConnectedAccountPurposeSettingsSection projection={projection} />

                    {authPlugin ? <AgentAuthenticationCard
                        agentId={agentId}
                        state={agentAuthentication}
                        showActions={supportsDesktopControls}
                        onCheckNow={() => {
                            if (!cliAgentId || !resolveCurrentExecutionTarget()) return;
                            cliAvailability.refresh({ bypassCache: true, includeLoginStatusForAgentIds: [cliAgentId] });
                        }}
                        onLaunchLogin={() => {
                            if (
                                !agentAuthentication.canLaunchLogin
                                || !supportsDesktopControls
                                || !cliAgentId
                                || !resolveCurrentExecutionTarget()
                            ) return;
                            pane.openBottom({ tabId: AGENT_AUTH_TERMINAL_TAB_ID });
                        }}
                    /> : null}

                <ItemGroup title={t('settingsAgents.cliConnection')}>
                    <Item
                        testID="settings-provider-target-machine"
                        title={t('settingsAgents.targetMachineTitle')}
                        subtitle={primaryMachineLabel ?? t('machine.detectedCliUnknown')}
                        icon={<Icon name="desktop" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    {agentCli ? (
                        <Item
                            testID="settings-provider-detected-cli"
                            title={t('settingsAgents.detectedCliTitle')}
                            subtitle={`${agentCli.executable.binaryName} • ${detectedCliStatus}`}
                            icon={<Icon name="code" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                        />
                    ) : null}
                    <Item
                        title={t('settingsAgents.installSetupTitle')}
                        subtitle={installSetupSubtitle}
                        icon={<Icon name="info" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    {agentCli && providerCliCapabilityId ? (
                        <AgentCliInstallItem
                            machineId={primaryMachine?.id ?? null}
                            serverId={capabilityServerId}
                            resolveExecutionTarget={resolveCurrentExecutionTarget}
                            capabilityId={providerCliCapabilityId}
                            providerTitle={projection.title}
                            installed={providerCliAvailable}
                            managedInstalled={providerCliManagedInstalled}
                            installability={cliInstallability}
                            intent={installIntent}
                            onManagedUpdateConfirmed={() => setProviderCliSourcePreference('managed-first')}
                            onInstalled={() => {
                                if (!cliAgentId || !resolveCurrentExecutionTarget()) return;
                                cliAvailability.refresh({
                                    bypassCache: true,
                                    includeLoginStatusForAgentIds: [cliAgentId],
                                });
                            }}
                        />
                    ) : null}
                    {supportsDesktopControls && agentCli?.install.managed ? (
                        <DropdownMenu
                            open={openMenu === 'cliSourcePreference'}
                            onOpenChange={(next) => setOpenMenu(next ? 'cliSourcePreference' : null)}
                            variant="selectable"
                            search={false}
                            selectedId={providerCliSourcePreference}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            popoverBoundaryRef={popoverBoundaryRef}
                            popoverPortalWebTarget="body"
                            itemTrigger={{
                                title: t('settingsAgents.cliSourcePreference.title'),
                                subtitle: t('settingsAgents.cliSourcePreference.subtitle'),
                                showSelectedSubtitle: false,
                                icon: <Icon name="arrows-left-right" size={29} color={theme.colors.text.secondary} />,
                                itemProps: {
                                    testID: 'settings-provider-cli-source-preference',
                                },
                            }}
                            items={[
                                {
                                    id: 'system-first',
                                    title: t('settingsAgents.cliSourcePreference.options.systemFirst.title'),
                                    subtitle: t('settingsAgents.cliSourcePreference.options.systemFirst.subtitle'),
                                    icon: (
                                        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                            <Icon name="desktop" size={20} color={theme.colors.text.secondary} />
                                        </View>
                                    ),
                                },
                                {
                                    id: 'managed-first',
                                    title: t('settingsAgents.cliSourcePreference.options.managedFirst.title'),
                                    subtitle: t('settingsAgents.cliSourcePreference.options.managedFirst.subtitle'),
                                    icon: (
                                        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                            <Icon name="download" size={20} color={theme.colors.text.secondary} />
                                        </View>
                                    ),
                                },
                            ]}
                            onSelect={(id) => {
                                setProviderCliSourcePreference(id as 'system-first' | 'managed-first');
                                setOpenMenu(null);
                            }}
                        />
                    ) : null}
                    {agentCli && (agentCli.install.guideUrl ?? agentCli.install.docsUrl) ? (
                        <Item
                            title={t('settingsAgents.setupGuideUrlTitle')}
                            subtitle={agentCli.install.guideUrl ?? agentCli.install.docsUrl!}
                            icon={<Icon name="link" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                            copy={agentCli.install.guideUrl ?? agentCli.install.docsUrl!}
                        />
                    ) : null}
                </ItemGroup>

                <AgentDetailExternalSessionsSection
                    agentId={agentId}
                    behaviorAgentId={projection.agentId}
                    agentTitle={projection.title}
                    machineId={primaryMachine?.id ?? null}
                    daemonStateVersion={primaryMachine?.daemonStateVersion ?? null}
                    serverId={capabilityServerId}
                    agent={externalSessionsAgent}
                    browseAvailable={externalSessionsBrowseAvailable}
                    refreshKey={externalSessionsRefreshKey}
                    projectionPhase={externalSessionsProjectionPhase}
                />

                {currentAgentCapabilities ? (
                    <>
                        <ItemGroup title={t('settingsAgents.capabilities')}>
                            <BadgeGrid items={capabilityBadges} columns={2} />
                        </ItemGroup>

                        {providerTargetKey ? <ItemGroup title={t('settingsAgents.models')}>
                            <Item
                                title={t('settingsProviders.models.manage')}
                                icon={<Icon name="sliders-horizontal" size={29} color={theme.colors.text.secondary} />}
                                onPress={() => router.push({
                                    pathname: '/(app)/settings/agents/[agentId]/models',
                                    params: {
                                        agentId,
                                        agentTargetKey: projection.backendTargetKey,
                                        pluginId: projection.identity?.pluginId ?? '',
                                        runtimeAgentId: '',
                                    },
                                } as never)}
                            />
                        </ItemGroup> : null}
                    </>
                ) : null}
            </ItemList>
    );
    const authTerminalBottomPaneAdapter = React.useMemo(() => ({
        destinationIds: [AGENT_AUTH_TERMINAL_TAB_ID],
        render: () => (
            authTerminalOpen && agentAuthentication.loginLaunch && cliAgentId ? (
                <AgentAuthenticationTerminalPane
                    agentId={cliAgentId}
                    machineId={agentAuthentication.machineId}
                    machineHomeDir={agentAuthentication.machineHomeDir}
                    loginLaunch={agentAuthentication.loginLaunch}
                    onRequestClose={closeProviderAuthTerminal}
                    onTerminalExit={handleProviderAuthTerminalExit}
                />
            ) : null
        ),
    }), [
        agentAuthentication.loginLaunch,
        agentAuthentication.machineHomeDir,
        agentAuthentication.machineId,
        authTerminalOpen,
        cliAgentId,
        closeProviderAuthTerminal,
        handleProviderAuthTerminalExit,
    ]);

    return (
        <View
            ref={popoverBoundaryRef}
            style={{ flex: 1, minHeight: 0 }}
            {...pane.overlayFocusReturnCaptureProps}
        >
            {supportsDesktopControls ? (
                <AppPaneScopeHost
                    scopeId={paneScopeId}
                    main={main}
                    bottomPaneBuiltinAdapter={authTerminalBottomPaneAdapter}
                />
            ) : (
                // Provider settings do not require the multi-pane host in the browser.
                main
            )}
        </View>
    );
});

export default React.memo(function AgentSettingsScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const settings = useSettings();
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents,
    );
    const rawAgentId = params.agentId;
    const normalizedAgentId = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
    const routePluginId = typeof params.pluginId === 'string' ? params.pluginId.trim() : '';
    const routeQualifiedAgent = React.useMemo(() => {
        if (!routePluginId || !normalizedAgentId) return null;
        const parsed = PluginContributionIdentityV1Schema.safeParse({
            pluginId: routePluginId,
            localId: normalizedAgentId,
        });
        return parsed.success ? parsed.data : null;
    }, [normalizedAgentId, routePluginId]);
    const hasQualifiedAgentRoute = routePluginId.length > 0;

    const recoveryInstallRequest = React.useMemo(() => {
        const machineId = typeof params.machineId === 'string' ? params.machineId.trim() : '';
        const serverId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
        const installIntent =
            params.installIntent === 'update'
                ? 'update'
                : params.installIntent === 'install'
                    ? 'install'
                    : null;
        if (!machineId || !serverId || !installIntent) {
            return null;
        }
        return { machineId, serverId, installIntent } as const;
    }, [
        params.installIntent,
        params.machineId,
        params.serverId,
    ]);
    const recoveryInstallTarget = React.useMemo(() => {
        if (!recoveryInstallRequest) return null;
        const candidate = administrationTargetSelection.candidates.find((entry) => (
            entry.target.machineId === recoveryInstallRequest.machineId
            && (
                entry.target.serverIdentityId === recoveryInstallRequest.serverId
                || areServerProfileIdentifiersEquivalent(
                    entry.target.serverIdentityId,
                    recoveryInstallRequest.serverId,
                )
            )
        ));
        return candidate
            ? { target: candidate.target, installIntent: recoveryInstallRequest.installIntent }
            : null;
    }, [administrationTargetSelection.candidates, recoveryInstallRequest]);
    const recoveryInstallRequestKey = recoveryInstallTarget
        ? `${recoveryInstallTarget.target.serverIdentityId}\u0000${recoveryInstallTarget.target.machineId}\u0000${recoveryInstallTarget.installIntent}`
        : null;
    const appliedRecoveryInstallRequestRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!recoveryInstallTarget || !recoveryInstallRequestKey) return;
        if (appliedRecoveryInstallRequestRef.current === recoveryInstallRequestKey) return;
        appliedRecoveryInstallRequestRef.current = recoveryInstallRequestKey;
        administrationTargetSelection.selectTarget(recoveryInstallTarget.target);
    }, [administrationTargetSelection, recoveryInstallRequestKey, recoveryInstallTarget]);
    const executionTarget = React.useMemo(() => {
        const selectedTarget = administrationTargetSelection.selectedTarget;
        const resolvedTarget = administrationTargetSelection.resolveExecutionTarget();
        return selectedTarget !== null
            && resolvedTarget !== null
            && machineAdministrationTargetsEqual(selectedTarget, resolvedTarget.target)
            ? resolvedTarget
            : null;
    }, [administrationTargetSelection]);
    const installIntent =
        recoveryInstallTarget
        && executionTarget
        && machineAdministrationTargetsEqual(recoveryInstallTarget.target, executionTarget.target)
            ? recoveryInstallTarget.installIntent
            : undefined;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: executionTarget?.machine.id ?? null,
        serverId: executionTarget?.serverId ?? null,
        enabled: executionTarget !== null,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.phase === 'ready'
        ? daemonMergedProjection.inputs
        : null;
    const legacyCompatAgentRedirectId = React.useMemo(() => resolveLegacyCompatAgentRouteRedirect({
        agentId: hasQualifiedAgentRoute ? '' : normalizedAgentId,
        daemonMergedProjectionInputs,
    }), [daemonMergedProjectionInputs, hasQualifiedAgentRoute, normalizedAgentId]);
    const waitingForLegacyCompatProjection = !hasQualifiedAgentRoute
        && isLegacyCompatAgentType(normalizedAgentId)
        && daemonMergedProjection.phase === 'loading'
        && !daemonMergedProjectionInputs
        && executionTarget !== null;

    if (waitingForLegacyCompatProjection) {
        return null;
    }
    if (!hasQualifiedAgentRoute && isLegacyCompatAgentType(normalizedAgentId)) {
        if (legacyCompatAgentRedirectId) {
            return (
                <Redirect
                    href={{
                        pathname: '/(app)/settings/agents/[agentId]',
                        params: { agentId: legacyCompatAgentRedirectId },
                    } as any}
                />
            );
        }
        return <Redirect href={'/(app)/settings/agents' as any} />;
    }

    const agentProjectionParams = React.useMemo(() => ({
        enabledAgentIds: [],
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
        mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
    }), [
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);
    const knownProviderIds = React.useMemo(() => {
        return new Set(
            getResolvedAgentCatalogEntries(agentProjectionParams).map((entry) => entry.agentId),
        );
    }, [agentProjectionParams]);
    const resolvedAgentProjectionId = React.useMemo(() => {
        if (hasQualifiedAgentRoute && !routeQualifiedAgent) return null;
        return resolveQualifiedAgentProjectionId({
            routeAgent: routeQualifiedAgent,
            fallbackAgentId: normalizedAgentId,
            mergedProviderProjectionById:
                daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
        });
    }, [
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        hasQualifiedAgentRoute,
        normalizedAgentId,
        routeQualifiedAgent,
    ]);
    const projection = React.useMemo(() => {
        if (!resolvedAgentProjectionId || !knownProviderIds.has(resolvedAgentProjectionId)) return null;
        return resolveAgentCatalogProjection(resolvedAgentProjectionId, agentProjectionParams);
    }, [
        knownProviderIds,
        agentProjectionParams,
        resolvedAgentProjectionId,
    ]);
    const compatibilityAgentId = projection?.catalogAgentId ?? null;
    const cliAgentId = projection?.cli ? projection.agentId : null;
    const currentAgentCapabilities = React.useMemo(() => readCurrentProjectedAgentCapabilities({
        projection: daemonMergedProjection.phase === 'ready'
            ? daemonMergedProjectionInputs?.pluginProjectionV2
            : null,
        agentId: resolvedAgentProjectionId,
    }), [
        daemonMergedProjection.phase,
        daemonMergedProjectionInputs?.pluginProjectionV2,
        resolvedAgentProjectionId,
    ]);
    const pluginSettingsProjection = React.useMemo(() => {
        for (const entry of Object.values(daemonMergedProjectionInputs?.pluginProjectionById ?? {})) {
            const matchingGroups = entry.editableSettingsGroups.filter((group) => (
                group.target.kind === 'agent'
                && (
                    routeQualifiedAgent
                        ? group.target.agent.pluginId === routeQualifiedAgent.pluginId
                            && group.target.agent.localId === routeQualifiedAgent.localId
                        : group.target.agent.localId === normalizedAgentId
                )
            ));
            if (matchingGroups.length > 0) {
                return {
                    ...entry,
                    editableSettingsGroups: matchingGroups,
                };
            }
        }
        return null;
    }, [
        daemonMergedProjectionInputs?.pluginProjectionById,
        normalizedAgentId,
        routeQualifiedAgent,
    ]);
    const compatibilityTargetKeys = React.useMemo(() => {
        const providerTargetKey = projection?.backendTargetKey;
        if (!providerTargetKey || !projection) return [] as string[];

        const nextCompatibilityTargetKeys = new Set(
            getAgentBackendCompatibilityTargetKeys({
                agentId: projection.agentId,
                canonicalTargetKey: providerTargetKey,
                mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
                mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
            }),
        );

        if (projection.isBuiltIn && compatibilityAgentId) {
            nextCompatibilityTargetKeys.add(buildBackendTargetKey({
                kind: 'builtInAgent',
                agentId: compatibilityAgentId,
            }));
        }

        nextCompatibilityTargetKeys.delete(providerTargetKey);
        return [...nextCompatibilityTargetKeys];
    }, [
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        projection,
        compatibilityAgentId,
    ]);
    const externalSessionsBinding = React.useMemo(() => {
        const pluginProjection = daemonMergedProjectionInputs?.pluginProjectionV2;
        return resolvedAgentProjectionId
            ? resolveExternalSessionsAgentBinding(
                pluginProjection,
                resolvedAgentProjectionId,
                routeQualifiedAgent,
            )
            : null;
    }, [
        daemonMergedProjectionInputs?.pluginProjectionV2,
        resolvedAgentProjectionId,
        routeQualifiedAgent,
    ]);
    const externalSessionsRefreshKey = externalSessionsBinding
        ? `${externalSessionsBinding.generation}:${executionTarget?.serverId ?? ''}:${executionTarget?.machine.id ?? ''}`
        : null;
    if (!normalizedAgentId) {
        return <AgentSettingsNotFound theme={theme} targetSelection={administrationTargetSelection} />;
    }

    if (!projection) {
        return <AgentSettingsNotFound theme={theme} targetSelection={administrationTargetSelection} />;
    }
    if (!currentAgentCapabilities && !projection.cli) {
        return (
            <AgentSettingsFallbackScreenInner
                projection={projection}
                pluginSettingsProjection={pluginSettingsProjection}
                targetSelection={administrationTargetSelection}
                executionTarget={executionTarget}
                daemonOperationsAvailable={executionTarget !== null && daemonMergedProjection.phase === 'ready'}
                externalSessionsProjectionPhase={daemonMergedProjection.phase}
                externalSessionsAgent={externalSessionsBinding?.agent ?? null}
                externalSessionsBrowseAvailable={externalSessionsBinding?.browseAvailable === true}
                externalSessionsRefreshKey={externalSessionsRefreshKey}
            />
        );
    }

    return (
        <AgentSettingsScreenInner
            agentId={resolvedAgentProjectionId ?? normalizedAgentId}
            cliAgentId={cliAgentId}
            projection={projection}
            currentAgentCapabilities={currentAgentCapabilities}
            authPlugin={projection.authPlugin}
            targetSelection={administrationTargetSelection}
            executionTarget={executionTarget}
            compatibilityTargetKeys={compatibilityTargetKeys}
            pluginSettingsProjection={pluginSettingsProjection}
            daemonOperationsAvailable={executionTarget !== null && daemonMergedProjection.phase === 'ready'}
            externalSessionsProjectionPhase={daemonMergedProjection.phase}
            externalSessionsAgent={externalSessionsBinding?.agent ?? null}
            externalSessionsBrowseAvailable={externalSessionsBinding?.browseAvailable === true}
            externalSessionsRefreshKey={externalSessionsRefreshKey}
            installIntent={installIntent}
        />
    );
});
