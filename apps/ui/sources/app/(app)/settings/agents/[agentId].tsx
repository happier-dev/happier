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
    getAgentCore,
    resolveBundledAgentIdFromContributionIdentity,
    type AgentId,
} from '@/agents/catalog/catalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    getResolvedAgentCatalogEntries,
    resolveAgentCatalogProjection,
    type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import { t } from '@/text';
import { getAgentCliRuntimeSpec, getAgentSessionModeDescriptor, getAgentStaticModels, isAgentAuthProbeSafeForBackgroundChecks } from '@happier-dev/agents';
import {
    buildCatalogModelList,
    classifySessionModeDescriptor,
    describeResumeSupportKind,
} from '@/agents/catalog/agentDetailsInfo';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { useCapabilityInstallability } from '@/hooks/machine/useCapabilityInstallability';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import { AgentCliInstallItem } from '@/components/settings/agents/AgentCliInstallItem';
import { resolveAgentChannelLabelKey } from '@/components/settings/agents/agentChannelLabel';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { AgentAuthenticationCard } from '@/components/settings/agents/authentication/AgentAuthenticationCard';
import { AgentAuthenticationTerminalPane } from '@/components/settings/agents/authentication/AgentAuthenticationTerminalPane';
import { scheduleAgentAuthenticationRefreshes } from '@/components/settings/agents/authentication/scheduleAgentAuthenticationRefreshes';
import { useAgentAuthenticationState } from '@/components/settings/agents/authentication/useAgentAuthenticationState';
import { resolveEffectiveConfiguredRuntimeControlSurface } from '@/sync/domains/session/control/effectiveRuntimeControlSurface';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useProfile } from '@/sync/store/hooks';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import {
    ConnectedServicesProviderStateSharingSettingsV1Schema,
    PluginContributionIdentityV1Schema,
    type ConnectedServicesDefaultAuthByAgentIdV1,
    type ConnectedServicesProviderStateSharingSettingsV1,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import { ConnectedServicesDefaultAuthRow } from '@/components/settings/connectedServices/ConnectedServicesDefaultAuthRow';
import {
    ConnectedServicesProviderStateSharingBackendGroups,
    resolveProviderStateSharingAgentIds,
} from '@/components/settings/connectedServices/ConnectedServicesProviderStateSharingSettings';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import {
    getAgentBackendCompatibilityTargetKeys,
    readBackendTargetSettingValue,
} from '@/agents/backendCatalog/backendTargetEnablement';
import { PluginDetailGenericSettingsSection } from '@/components/settings/plugins/detail/PluginDetailGenericSettingsSection';
import type { ScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import { ExternalSessionsAgentSettingsSection } from '@/components/settings/externalSessions/ExternalSessionsAgentSettingsSection';
import type {
    ExternalSessionsQualifiedAgent,
} from '@/components/settings/externalSessions/externalSessionsIntegrationModel';
import { useExternalSessionsIntegrationController } from '@/components/settings/externalSessions/externalSessionsIntegrationController';
import { useExternalSessionsAutoLinkSources } from '@/components/settings/externalSessions/useExternalSessionsAutoLinkSources';
import { buildExternalSessionsAgentBrowseHref } from '@/components/sessions/external/browse/externalSessionBrowseNavigation';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { Icon } from '@/components/ui/icons/Icon';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import {
    useMachineAdministrationTargetSelection,
    type FreshMachineAdministrationExecutionTargetV1,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
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

function resolveProjectionIconName(projection: ResolvedAgentCatalogEntry): string {
    return projection.iconAgentId ? getAgentCore(projection.iconAgentId).ui.agentPickerIconName : projection.iconName;
}

type AgentSettingsCore = NonNullable<ReturnType<typeof getAgentCore>>;

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

const AgentSettingsFallbackScreenInner = React.memo(function AgentSettingsFallbackScreenInner(props: Readonly<{
    projection: ResolvedAgentCatalogEntry;
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
    const iconName = resolveProjectionIconName(props.projection);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={title} footer={t('settingsAgents.footer')}>
                <Item
                    title={title}
                    subtitle={subtitle}
                    icon={<Icon name={iconName as any} size={29} color={theme.colors.text.secondary} />}
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
    runtimeAgentId: AgentId | null;
    cliAgentId: string | null;
    core: AgentSettingsCore | null;
    projection: ResolvedAgentCatalogEntry;
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
    const supportsDesktopControls = isTauriDesktop();
    const {
        agentId,
        runtimeAgentId,
        cliAgentId,
        core,
        projection,
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
    const providerIconName = resolveProjectionIconName(projection);
    const activeServer = useActiveServerSnapshot();
    const accountServerIdentityId = React.useMemo(
        () => resolveScopedPluginSettingsServerIdentity(activeServer.serverId),
        [activeServer.serverId],
    );
    const profile = useProfile();
    const settings = useSettings();
    const paneScopeId = React.useMemo(
        () => `settings:provider:${agentId}`,
        [agentId],
    );
    const pane = useAppPaneScope(paneScopeId);
    const applySettings = useApplySettings();
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const externalSessionsEnabled = useFeatureEnabled('sessions.direct');
    const externalSessionsExpected = React.useMemo(
        () => resolveAgentUiBehavior(projection.agentId).externalSessions !== undefined,
        [projection.agentId],
    );

    const popoverBoundaryRef = React.useRef<any>(null);
    const [openMenu, setOpenMenu] = React.useState<null | string>(null);

    const sessionModeDescriptor = runtimeAgentId ? getAgentSessionModeDescriptor(runtimeAgentId) : null;
    const agentCliRuntimeSpec = runtimeAgentId ? getAgentCliRuntimeSpec(runtimeAgentId) : null;
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

    const setDefaultAuthSettings = React.useCallback((next: ConnectedServicesDefaultAuthByAgentIdV1) => {
        applySettings({
            connectedServicesDefaultAuthByAgentIdV1: next,
        });
    }, [applySettings]);
    const dismissPoolAdoptionSuggestion = React.useCallback((key: string) => {
        applySettings({
            connectedServicesDefaultAuthPoolAdoptionDismissedByKey: {
                ...(settings.connectedServicesDefaultAuthPoolAdoptionDismissedByKey ?? {}),
                [key]: true,
            },
        });
    }, [applySettings, settings.connectedServicesDefaultAuthPoolAdoptionDismissedByKey]);

    const normalizedProviderStateSharingSettings = React.useMemo(
        () => ConnectedServicesProviderStateSharingSettingsV1Schema.parse(settings.connectedServicesProviderStateSharingSettingsV1),
        [settings.connectedServicesProviderStateSharingSettingsV1],
    );

    const setProviderStateSharingSettings = React.useCallback((next: ConnectedServicesProviderStateSharingSettingsV1) => {
        applySettings({
            connectedServicesProviderStateSharingSettingsV1: next,
        });
    }, [applySettings]);

    const supportsConnectedServicesDefaultAuth =
        runtimeAgentId != null
        && (core?.connectedServices?.supportedServiceIds ?? []).length > 0;
    const supportsProviderStateSharingSettings =
        runtimeAgentId != null
        && resolveProviderStateSharingAgentIds([runtimeAgentId]).length > 0;

    const backendCliSourcePreferenceByTargetKey = settings.backendCliSourcePreferenceByTargetKey;
    const providerCliSourcePreference =
        providerTargetKey && agentCliRuntimeSpec
            ? (
                readBackendTargetSettingValue({
                    valuesByTargetKey: backendCliSourcePreferenceByTargetKey,
                    canonicalTargetKey: providerTargetKey,
                    compatibilityTargetKeys,
                }) ?? agentCliRuntimeSpec.sourcePreferenceDefault
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

    const effectiveRuntimeControlSurface = React.useMemo(
        () => runtimeAgentId
            ? resolveEffectiveConfiguredRuntimeControlSurface({
                agentId: runtimeAgentId,
                accountSettings: settings as Record<string, unknown>,
            })
            : null,
        [runtimeAgentId, settings],
    );
    const runtimeVendorResumeSupport = effectiveRuntimeControlSurface?.resume.vendorResume;
    const resumeSupportKind = describeResumeSupportKind({
        supportsVendorResume: runtimeVendorResumeSupport === 'supported' || runtimeVendorResumeSupport === 'experimental',
        experimental: runtimeVendorResumeSupport === 'experimental',
    });
    const resumeSupport = {
        supported: t('settingsAgents.resumeSupportSupported'),
        supportedExperimental: t('settingsAgents.resumeSupportSupportedExperimental'),
        notSupported: t('settingsAgents.resumeSupportNotSupported'),
    }[resumeSupportKind];
    const { sessionModeKind, runtimeSwitchKind } = sessionModeDescriptor
        ? classifySessionModeDescriptor(sessionModeDescriptor)
        : { sessionModeKind: 'none', runtimeSwitchKind: 'none' as const };
    const sessionModeSupport = {
        none: t('settingsAgents.sessionModeNone'),
        acpPolicyPresets: t('settingsAgents.sessionModeAcpPolicyPresets'),
        acpAgentModes: t('settingsAgents.sessionModeAcpAgentModes'),
        staticAgentModes: t('settingsAgents.sessionModeStaticAgentModes'),
    }[sessionModeKind];
    const runtimeSwitchSupport = {
        none: t('settingsAgents.runtimeSwitchNone'),
        metadataGating: t('settingsAgents.runtimeSwitchMetadataGating'),
        acpSetSessionMode: t('settingsAgents.runtimeSwitchAcpSetSessionMode'),
        providerNative: t('settingsAgents.runtimeSwitchProviderNative'),
    }[runtimeSwitchKind];
    const catalogModelList = buildCatalogModelList({
        defaultMode: core?.model.defaultMode,
        allowedModes: core?.model.allowedModes ?? [],
        staticModels: core ? getAgentStaticModels(core.id) : [],
    });
    const defaultModelLabel = core?.model.defaultMode?.trim()
        ? (catalogModelList[0] ?? core.model.defaultMode.trim())
        : t('settingsAgents.notAvailable');
    const catalogModelListText = catalogModelList.length > 0
        ? catalogModelList.join(', ')
        : t('settingsAgents.catalogModelListEmpty');
    const dynamicProbe = core?.model.dynamicProbe === 'static-only'
        ? t('settingsAgents.dynamicModelProbeStaticOnly')
        : t('settingsAgents.dynamicModelProbeAuto');
    const nonAcpApplyScope = core?.model.nonAcpApplyScope === 'spawn_only'
        ? t('settingsAgents.nonAcpApplyScopeSpawnOnly')
        : t('settingsAgents.nonAcpApplyScopeNextPrompt');
    const acpApplyBehavior = core?.model.acpApplyBehavior === 'set_model'
        ? t('settingsAgents.acpApplyBehaviorSetModel')
        : core?.model.acpApplyBehavior === 'restart_session'
            ? t('settingsAgents.acpApplyBehaviorRestartSession')
            : t('settingsAgents.notAvailable');
    const installInfo = !core
        ? t('settingsAgents.notAvailable')
        : core.cli.installBanner.installKind === 'command'
            ? (core.cli.installBanner.installCommand ?? t('settingsAgents.installInfoSeeSetupGuide'))
            : t('settingsAgents.installInfoUseAgentCliInstaller');

    const primaryMachine = executionTarget?.machine ?? null;
    const capabilityServerId = executionTarget?.serverId ?? null;
    const capabilityServerIdentityId = executionTarget?.target.serverIdentityId ?? null;
    const resolveCurrentExecutionTarget = React.useCallback(() => {
        const expectedTarget = executionTarget?.target;
        const resolvedTarget = targetSelection.resolveExecutionTarget();
        if (
            !expectedTarget
            || !resolvedTarget
            || !machineAdministrationTargetsEqual(expectedTarget, resolvedTarget.target)
        ) {
            return null;
        }
        return {
            machineId: resolvedTarget.machine.id,
            serverId: resolvedTarget.serverId,
        };
    }, [executionTarget?.target, targetSelection]);
    const isDaemonSettingsTargetCurrent = React.useCallback((target: Extract<ScopedPluginSettingsTarget, { kind: 'daemon' }>) => {
        const resolvedTarget = targetSelection.resolveExecutionTarget();
        return resolvedTarget !== null
            && resolvedTarget.machine.id === target.machineId
            && resolvedTarget.serverId === target.serverId
            && resolvedTarget.target.serverIdentityId === target.serverIdentityId;
    }, [targetSelection]);
    const externalSessionsControllerAgent = React.useMemo(() => (
        externalSessionsAgent
            ? {
                agent: externalSessionsAgent,
                agentTitle: projection.title,
            }
            : null
    ), [externalSessionsAgent, projection.title]);
    const externalSessionsController = useExternalSessionsIntegrationController({
        machineId: primaryMachine?.id ?? null,
        serverId: capabilityServerId,
        projectionGeneration: `${externalSessionsRefreshKey ?? ''}:${primaryMachine?.daemonStateVersion ?? 0}`,
        agent: externalSessionsControllerAgent,
        enabled: externalSessionsEnabled && externalSessionsAgent !== null && primaryMachine !== null,
    });
    const externalSessionsInventoryState = React.useMemo(() => {
        if (
            !externalSessionsEnabled
            || !primaryMachine
            || externalSessionsAgent
            || !externalSessionsExpected
        ) {
            return externalSessionsController.inventoryState;
        }
        if (externalSessionsProjectionPhase === 'loading') {
            return {
                status: 'loading' as const,
                diagnosticCodes: [],
            };
        }
        return {
            status: 'error' as const,
            diagnosticCodes: [
                externalSessionsProjectionPhase === 'unsupported'
                    ? 'external_sessions_projection_unsupported'
                    : 'external_sessions_projection_unavailable',
            ],
        };
    }, [
        externalSessionsAgent,
        externalSessionsController.inventoryState,
        externalSessionsEnabled,
        externalSessionsExpected,
        externalSessionsProjectionPhase,
        primaryMachine,
    ]);
    const externalSessionsAutoLinkKnownAgents = React.useMemo(
        () => externalSessionsControllerAgent ? [externalSessionsControllerAgent] : [],
        [externalSessionsControllerAgent],
    );
    const externalSessionsAutoLinkSources = useExternalSessionsAutoLinkSources({
        rawSettings: settings.externalSessionsSettingsV1,
        knownAgents: externalSessionsAutoLinkKnownAgents,
        enabled: primaryMachine !== null && externalSessionsAgent !== null,
        ...(primaryMachine && externalSessionsAgent
            ? {
                scope: {
                    machineId: primaryMachine.id,
                    agent: externalSessionsAgent,
                },
            }
            : {}),
    });
    const automaticLoginStatusAgentIds = React.useMemo(
        () => (runtimeAgentId && isAgentAuthProbeSafeForBackgroundChecks(runtimeAgentId) ? [runtimeAgentId] : []),
        [runtimeAgentId],
    );
    const cliAvailability = useCLIDetection(primaryMachine?.id ?? null, {
        autoDetect: primaryMachine !== null,
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
            status: resumeSupportKind === 'supported' || resumeSupportKind === 'supportedExperimental' ? 'positive' : resumeSupportKind === 'notSupported' ? 'negative' : 'neutral',
            detail: resumeSupport,
        },
        {
            id: 'sessionMode',
            label: t('settingsAgents.sessionModeSupportTitle'),
            status: sessionModeKind !== 'none' ? 'positive' : 'negative',
            detail: sessionModeSupport,
        },
        {
            id: 'runtimeSwitch',
            label: t('settingsAgents.runtimeModeSwitchingTitle'),
            status: runtimeSwitchKind !== 'none' ? 'positive' : 'negative',
            detail: runtimeSwitchSupport,
        },
        {
            id: 'localControl',
            label: t('settingsAgents.localControlTitle'),
            status: effectiveRuntimeControlSurface?.localControl?.supported === true ? 'positive' : 'negative',
            detail: effectiveRuntimeControlSurface?.localControl?.supported === true ? t('settingsAgents.supported') : t('settingsAgents.notSupported'),
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
                {pluginSettingsProjection ? (
                    <PluginDetailGenericSettingsSection
                        pluginId={pluginSettingsProjection.pluginId}
                        projection={pluginSettingsProjection}
                        machineId={primaryMachine?.id ?? null}
                        serverId={capabilityServerId}
                        accountServerIdentityId={accountServerIdentityId}
                        daemonServerIdentityId={capabilityServerIdentityId}
                        daemonOperationsAvailable={daemonOperationsAvailable}
                        isDaemonTargetCurrent={isDaemonSettingsTargetCurrent}
                    />
                ) : null}
                <ItemGroup title={t('settingsAgents.configuration')} footer={core ? t(core.subtitleKey) : t('settingsAgents.footer')}>
                <Item
                    title={projection.title}
                    subtitle={projection.subtitle ?? projection.agentId}
                    icon={<Icon name={providerIconName as any} size={29} color={theme.colors.text.secondary} />}
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

                {runtimeAgentId && providerTargetKey ? (
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
                            subtitle: getPermissionModeLabelForAgentType(runtimeAgentId, permissionMode),
                            icon: <Icon name="shield-check" size={29} color={theme.colors.state.success.foreground} />,
                        }}
                        items={getPermissionModeOptionsForAgentType(runtimeAgentId).map((opt) => ({
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
                            const nextMode = getPermissionModeOptionsForAgentType(runtimeAgentId).find((opt) => opt.value === id)?.value;
                            if (nextMode) setPermissionMode(nextMode);
                            setOpenMenu(null);
                        }}
                    />
                    </ItemGroup>
                ) : null}

                {supportsConnectedServicesDefaultAuth && runtimeAgentId && core ? (
                    <ItemGroup
                        title={t('connectedServices.defaultAuth.agentDetailTitle')}
                        footer={t('connectedServices.defaultAuth.agentDetailFooter')}
                    >
                        <ConnectedServicesDefaultAuthRow
                            agentId={runtimeAgentId}
                            agentTitle={t(core.displayNameKey)}
                            agentCore={core}
                            accountGroupsEnabled={accountGroupsEnabled}
                            accountProfileConnectedServicesV2={profile.connectedServicesV2 ?? []}
                            settings={{
                                connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey ?? {},
                                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId ?? {},
                                connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
                            }}
                            setDefaultAuthSettings={setDefaultAuthSettings}
                            onOpenConnectedServicesSettings={(serviceId) => router.push({
                                pathname: '/(app)/settings/connected-services/[serviceId]',
                                params: { serviceId },
                            } as any)}
                            dismissedPoolAdoptionSuggestionKeys={settings.connectedServicesDefaultAuthPoolAdoptionDismissedByKey}
                            onDismissPoolAdoptionSuggestion={dismissPoolAdoptionSuggestion}
                        />
                    </ItemGroup>
                ) : null}

                {supportsProviderStateSharingSettings && runtimeAgentId ? (
                    <ConnectedServicesProviderStateSharingBackendGroups
                        settings={normalizedProviderStateSharingSettings}
                        setSettings={setProviderStateSharingSettings}
                        agentIds={[runtimeAgentId]}
                    />
                ) : null}

                    <AgentAuthenticationCard
                        agentId={agentId}
                        runtimeAgentId={runtimeAgentId}
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
                    />

                <ItemGroup title={t('settingsAgents.cliConnection')}>
                    <Item
                        testID="settings-provider-target-machine"
                        title={t('settingsAgents.targetMachineTitle')}
                        subtitle={primaryMachineLabel ?? t('machine.detectedCliUnknown')}
                        icon={<Icon name="desktop" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                    {core ? (
                        <Item
                            testID="settings-provider-detected-cli"
                            title={t('settingsAgents.detectedCliTitle')}
                            subtitle={`${core.cli.detectKey} • ${detectedCliStatus}`}
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
                    {core && providerCliCapabilityId ? (
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
                    {supportsDesktopControls && agentCliRuntimeSpec?.managedInstall ? (
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
                    {core?.cli.installBanner.guideUrl ? (
                        <Item
                            title={t('settingsAgents.setupGuideUrlTitle')}
                            subtitle={core.cli.installBanner.guideUrl}
                            icon={<Icon name="link" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                            copy={core.cli.installBanner.guideUrl}
                        />
                    ) : null}
                    {core ? (
                        <Item
                            title={t('settingsAgents.connectedServiceTitle')}
                            subtitle={t(core.uiConnectedService.labelKey)}
                            icon={<Icon name="cloud" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                        />
                    ) : null}
                </ItemGroup>

                {externalSessionsEnabled ? (
                    <ExternalSessionsAgentSettingsSection
                        machineId={primaryMachine?.id ?? null}
                        agent={externalSessionsAgent}
                        agentTitle={projection.title}
                        integrations={externalSessionsController.integrations}
                        autoLinkSources={externalSessionsAutoLinkSources}
                        operations={externalSessionsController.operations}
                        inventoryState={externalSessionsInventoryState}
                        onRetryInventory={
                            externalSessionsAgent
                                ? externalSessionsController.retryInventory
                                : null
                        }
                        hasMoreInventory={externalSessionsController.hasMoreInventory}
                        loadingMoreInventory={externalSessionsController.loadingMoreInventory}
                        onLoadMoreInventory={externalSessionsController.loadMoreInventory}
                        onBrowse={
                            primaryMachine
                            && externalSessionsAgent
                            && externalSessionsBrowseAvailable
                                ? () => {
                                    router.push(buildExternalSessionsAgentBrowseHref({
                                        machineId: primaryMachine.id,
                                        serverId: capabilityServerId,
                                        agentId,
                                        agent: externalSessionsAgent,
                                    }));
                                }
                                : null
                        }
                        onManageAll={() => {
                            router.push({
                                pathname: '/settings/external-sessions',
                                params: {
                                    machineId: primaryMachine?.id ?? '',
                                },
                            });
                        }}
                    />
                ) : null}

                {core ? (
                    <>
                        <ItemGroup title={t('settingsAgents.capabilities')}>
                            <BadgeGrid items={capabilityBadges} columns={2} />
                        </ItemGroup>

                        <ItemGroup title={t('settingsAgents.models')}>
                            <Item
                                title={t('settingsProviders.models.manage')}
                                icon={<Icon name="sliders-horizontal" size={29} color={theme.colors.text.secondary} />}
                                onPress={() => router.push({
                                    pathname: '/(app)/settings/agents/[agentId]/models',
                                    params: {
                                        agentId,
                                        agentTargetKey: projection.backendTargetKey,
                                        runtimeAgentId: runtimeAgentId ?? '',
                                    },
                                } as never)}
                            />
                            <Item
                                title={t('settingsAgents.modelSelectionTitle')}
                                subtitle={core.model.supportsSelection ? t('settingsAgents.supported') : t('settingsAgents.notSupported')}
                                icon={<Icon name="list" size={29} color={theme.colors.text.secondary} />}
                                mode="info"
                            />
                            <Item
                                title={t('settingsAgents.freeformModelIdsTitle')}
                                subtitle={core.model.supportsFreeform ? t('settingsAgents.allowed') : t('settingsAgents.notAllowed')}
                                icon={<Icon name="pencil-simple" size={29} color={theme.colors.text.secondary} />}
                                mode="info"
                            />
                            <Item
                                title={t('settingsAgents.defaultModelTitle')}
                                subtitle={defaultModelLabel}
                                icon={<Icon name="star" size={29} color={theme.colors.text.secondary} />}
                                mode="info"
                            />
                            <Item
                                title={t('settingsAgents.catalogModelListTitle')}
                                subtitle={catalogModelListText}
                                icon={<Icon name="stack" size={29} color={theme.colors.text.secondary} />}
                                mode="info"
                            />
                            <Item
                                title={t('settingsAgents.dynamicModelProbeTitle')}
                                subtitle={dynamicProbe}
                                icon={<Icon name="pulse" size={29} color={theme.colors.text.secondary} />}
                                mode="info"
                            />
                            <Item
                                title={t('settingsAgents.nonAcpApplyScopeTitle')}
                                subtitle={nonAcpApplyScope}
                                icon={<Icon name="arrow-right" size={29} color={theme.colors.text.secondary} />}
                                mode="info"
                            />
                            <Item
                                title={t('settingsAgents.acpApplyBehaviorTitle')}
                                subtitle={acpApplyBehavior}
                                icon={<Icon name="arrows-clockwise" size={29} color={theme.colors.text.secondary} />}
                                mode="info"
                            />
                            <Item
                                title={t('settingsAgents.acpConfigOptionTitle')}
                                subtitle={core.model.acpModelConfigOptionId ?? t('settingsAgents.notAvailable')}
                                icon={<Icon name="sliders-horizontal" size={29} color={theme.colors.text.secondary} />}
                                mode="info"
                            />
                        </ItemGroup>
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
        retainInputsAcrossScopeChange: true,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.inputs;
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
    const runtimeAgentId = projection?.catalogAgentId ?? null;
    const cliAgentId = projection?.authPlugin ? projection.agentId : runtimeAgentId;
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

        if (projection.isBuiltIn && runtimeAgentId) {
            nextCompatibilityTargetKeys.add(buildBackendTargetKey({
                kind: 'builtInAgent',
                agentId: runtimeAgentId,
            }));
        }

        nextCompatibilityTargetKeys.delete(providerTargetKey);
        return [...nextCompatibilityTargetKeys];
    }, [
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        projection,
        runtimeAgentId,
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
    if (!runtimeAgentId && !projection.authPlugin) {
        return <AgentSettingsFallbackScreenInner projection={projection} />;
    }

    return (
        <AgentSettingsScreenInner
            agentId={resolvedAgentProjectionId ?? normalizedAgentId}
            runtimeAgentId={runtimeAgentId}
            cliAgentId={cliAgentId}
            core={runtimeAgentId ? getAgentCore(runtimeAgentId) : null}
            projection={projection}
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
