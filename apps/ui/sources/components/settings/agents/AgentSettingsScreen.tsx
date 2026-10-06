import React from 'react';
import { View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { AgentDetailHeader, AgentMachineContextBar } from '@/components/settings/agents/detail/AgentDetailHeader';
import { AgentAttentionBanner, AgentMachineOfflineBanner } from '@/components/settings/agents/detail/AgentAttentionBanner';
import {
    useAgentsAdministrationTargetSelection,
    useAgentsMachineScope,
} from '@/components/settings/agents/collection/useAgentAdministrationCatalog';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { BadgeGrid, type BadgeGridItem } from '@/components/ui/layout/BadgeGrid';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import {
    resolveBundledAgentIdFromContributionIdentity,
} from '@/agents/catalog/catalog';
import {
    useDaemonMergedProjectionInputs,
    type DaemonMergedProjectionPhase,
} from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
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
import { MachineAgentReadiness } from '@/components/machines/agents/MachineAgentReadiness';
import { AgentSignInPaneHost } from '@/components/machines/agents/AgentSignInPaneHost';
import { useMachineAgent } from '@/agents/machineAgents/useMachineAgents';
import { resolveAgentChannelLabelKey } from '@/components/settings/agents/agentChannelLabel';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { isPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import {
    PluginContributionIdentityV1Schema,
    PluginAgentCliSourcePreferenceSchema,
    readAccountSettingValueForBackendTarget,
    qualifiedPurposeKey,
    resolveAgentConnectedAccountPurposeDefaults,
    writeAgentConnectedAccountPurposeDefault,
    type AgentConnectedAccountPurposeTeamResourceDefault,
    type PluginProjectedAgentConnectedAccountPurposeV2,
    type QualifiedConnectedAccountPurposeBindingTargetV1,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import {
    getAgentBackendCompatibilityTargetKeys,
} from '@/agents/backendCatalog/backendTargetEnablement';
import { PluginDetailGenericSettingsSection } from '@/components/settings/plugins/detail/PluginDetailGenericSettingsSection';
import type { ScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import { AgentDetailExternalSessionsSection } from '@/components/settings/externalSessions/AgentDetailExternalSessionsSection';
import type {
    ExternalSessionsQualifiedAgent,
} from '@/components/settings/externalSessions/externalSessionsIntegrationModel';
import {
    resolveAgentDetailExternalSessionsBinding,
    resolveAgentDetailPluginSettingsProjection,
    resolveAgentDetailQualifiedIdentity,
} from '@/components/settings/agents/resolveAgentDetailSettingsProjection';
import { Icon } from '@/components/ui/icons/Icon';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import {
    type FreshMachineAdministrationExecutionTargetV1,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isAdministrationScopedPluginSettingsTargetCurrent } from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjection';

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


/**
 * The one line under an agent's name: what it is when that adds anything, its CLI and version,
 * a non-stable release channel, and the machine this page manages.
 */
function describeAgentDetail(params: Readonly<{
    agentId: string;
    subtitle: string | null;
    binaryName: string | null;
    version: string | null;
    cliAvailable: boolean | null;
    channelLabel: string | null;
    machineLabel: string | null;
}>): string {
    const subtitle = params.subtitle && params.subtitle !== params.agentId && params.subtitle !== params.binaryName
        ? params.subtitle
        : null;
    const cli = params.binaryName && params.cliAvailable !== false
        ? params.version
            ? t('settingsAgents.detailPage.cliVersion', { cli: params.binaryName, version: params.version })
            : t('settingsAgents.detailPage.cliName', { cli: params.binaryName })
        : null;
    const machine = params.machineLabel
        ? params.cliAvailable === false
            ? t('settingsAgents.detailPage.notInstalledOnMachine', { machine: params.machineLabel })
            : t('settingsAgents.detailPage.onMachine', { machine: params.machineLabel })
        : null;
    return [subtitle, cli, params.channelLabel, machine].filter(Boolean).join(' · ');
}

/**
 * Where the managed machine stands for this page. Only readiness, CLI, install and sign-in depend
 * on it; the agent's settings are Account settings and never wait for it.
 */
type AgentMachineState = 'none' | 'offline' | 'checking' | 'error' | 'ready';

function AgentMachineReadinessStateRow(props: Readonly<{
    state: Exclude<AgentMachineState, 'offline' | 'ready'>;
    agentTitle: string;
    machineLabel: string | null;
    onRetry: () => void;
}>) {
    if (props.state === 'none') {
        return (
            <Item
                testID="settings.agents.detail.noMachine"
                title={t('settingsAgents.detailPage.noMachineTitle')}
                subtitle={t('settingsAgents.detailPage.noMachineDescription', { agent: props.agentTitle })}
                subtitleLines={0}
                mode="info"
            />
        );
    }
    if (props.state === 'checking') {
        return (
            <Item
                testID="settings.agents.detail.machineChecking"
                title={props.machineLabel
                    ? t('settingsAgents.detailPage.checkingMachine', { machine: props.machineLabel })
                    : t('common.loading')}
                loading
                mode="info"
            />
        );
    }
    return (
        <Item
            testID="settings.agents.detail.machineError"
            title={t('common.unavailable')}
            subtitle={t('settingsAgents.detailPage.machineUnavailableDescription')}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            rightElement={(
                <RoundButton size="small" display="secondary" title={t('common.retry')} onPress={props.onRetry} />
            )}
        />
    );
}

/** Loading, error and not-found agent pages keep the machine chip: it is how they recover. */
function AgentSettingsStatusHeader(props: Readonly<{ targetSelection: MachineAdministrationTargetSelectionV1 }>) {
    return (
        <>
            <AgentMachineContextBar targetSelection={props.targetSelection} />
            <SettingsPageHeader />
        </>
    );
}

const AgentSettingsNotFound = React.memo(function AgentSettingsNotFound(props: Readonly<{
    theme: ReturnType<typeof useUnistyles>['theme'];
    targetSelection: MachineAdministrationTargetSelectionV1;
}>) {
    return (
        <ItemList>
            <AgentSettingsStatusHeader targetSelection={props.targetSelection} />
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

const AgentSettingsProjectionStatus = React.memo(function AgentSettingsProjectionStatus(props: Readonly<{
    phase: Exclude<DaemonMergedProjectionPhase, 'ready'>;
    targetSelection: MachineAdministrationTargetSelectionV1;
    onRetry?: () => void;
}>) {
    const loading = props.phase === 'loading';
    const retryable = props.phase === 'error' && props.onRetry !== undefined;
    return (
        <ItemList>
            <AgentSettingsStatusHeader targetSelection={props.targetSelection} />
            <ItemGroup>
                <Item
                    testID="settings.agents.projection.status"
                    title={loading ? t('common.loading') : t('common.unavailable')}
                    detail={retryable ? t('common.retry') : undefined}
                    loading={loading}
                    mode={retryable ? undefined : 'info'}
                    showChevron={retryable}
                    onPress={retryable ? props.onRetry : undefined}
                />
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
            accountOperationsAvailable={targetSelection.selectedTargetServerMatchesActiveAccount}
            daemonOperationsAvailable={daemonOperationsAvailable}
            isDaemonTargetCurrent={isDaemonSettingsTargetCurrent}
        />
    );
});

const AgentConnectedAccountPurposeSettingsSection = React.memo(function AgentConnectedAccountPurposeSettingsSection(
    props: Readonly<{
        projection: ResolvedAgentCatalogEntry;
        accountSettingsAvailable: boolean;
    }>,
) {
    const settings = useSettingsSelector((settings) => ({
        connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
    }));
    const applySettings = useApplySettings();
    const identity = props.projection.identity;
    const declarations = React.useMemo(
        () => props.projection.connectedAccounts ?? [],
        [props.projection.connectedAccounts],
    );
    // Agent purposes are materialized inside a Session, where the Home admits a
    // Team binding, so this surface offers the viewer's entitled Team resources.
    const activeAccountScope = useActiveServerAccountScope();
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: activeAccountScope?.serverId,
    });
    const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId: activeAccountScope?.serverId,
        enabled: teamCredentialResourcesEnabled && declarations.length > 0,
    });
    // The one Agent default-authentication owner reads and writes these
    // purpose defaults; a released service-keyed default is shown until the
    // first write folds it into the purpose-binding store.
    const defaultAuthSettings = React.useMemo(() => ({
        connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
    }), [settings.connectedAccountPurposeBindingsV1, settings.connectedServicesDefaultAuthByAgentIdV1]);
    const defaultsByPurposeKey = React.useMemo(() => new Map(
        identity
            ? resolveAgentConnectedAccountPurposeDefaults({
                settings: defaultAuthSettings,
                agentId: props.projection.agentId,
                consumer: identity,
                declarations,
            }).map((entry) => [qualifiedPurposeKey(entry.purpose), entry] as const)
            : [],
    ), [declarations, defaultAuthSettings, identity, props.projection.agentId]);
    // A Team resource choice is written as the canonical Team selection of its
    // Team (lane 10 child 02 :271, child 06 :506), never as a purpose target.
    const setTarget = React.useCallback((
        declaration: PluginProjectedAgentConnectedAccountPurposeV2,
        target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
        teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null,
    ) => {
        if (!identity || !props.accountSettingsAvailable) return;
        applySettings(writeAgentConnectedAccountPurposeDefault({
            settings: defaultAuthSettings,
            agentId: props.projection.agentId,
            consumer: identity,
            declarations,
            purpose: declaration.purpose,
            target,
            teamResource,
        }));
    }, [applySettings, declarations, defaultAuthSettings, identity, props.accountSettingsAvailable, props.projection.agentId]);

    if (!identity || declarations.length === 0) return null;
    return (
        <ItemGroup
            title={t('connectedServices.defaultAuth.agentDetailTitle')}
            description={t('connectedServices.defaultAuth.agentDetailFooter')}
        >
            {declarations.map((declaration) => {
                const purpose = { consumer: identity, purpose: declaration.purpose };
                const purposeKey = qualifiedPurposeKey(purpose);
                return (
                    <ConnectedAccountPurposeTargetChooser
                        key={purposeKey}
                        testID={`agent-connected-account-purpose:${declaration.purpose}`}
                        localizedTextPluginId={identity.pluginId}
                        declaration={declaration}
                        value={defaultsByPurposeKey.get(purposeKey)?.target ?? null}
                        teamResourceValue={defaultsByPurposeKey.get(purposeKey)?.teamResource ?? null}
                        teamCredentialCatalog={teamCredentialCatalog}
                        onReload={teamCredentialCatalog.reload}
                        disabled={!props.accountSettingsAvailable}
                        disabledReason={!props.accountSettingsAvailable
                            ? t('connectedServices.accountScopeMismatchDescription')
                            : undefined}
                        onChange={(target, teamResource) => setTarget(declaration, target, teamResource)}
                    />
                );
            })}
        </ItemGroup>
    );
});

/**
 * Session defaults are Account settings keyed by the agent's backend target: they load and save
 * with no machine, and apply on every machine a new session starts on.
 */
const AgentSessionDefaultsSection = React.memo(function AgentSessionDefaultsSection(props: Readonly<{
    projection: ResolvedAgentCatalogEntry;
    compatibilityTargetKeys: readonly string[];
    accountSettingsAvailable: boolean;
    /** The popover boundary the dropdown form of the permission choice measures against. */
    popoverBoundaryRef?: React.ComponentProps<typeof DropdownMenu>['popoverBoundaryRef'];
    onOpenModels: (() => void) | null;
}>) {
    const settings = useSettingsSelector((settings) => ({
        sessionDefaultPermissionModeByTargetKey: settings.sessionDefaultPermissionModeByTargetKey,
    }));
    const applySettings = useApplySettings();
    const [permissionMenuOpen, setPermissionMenuOpen] = React.useState(false);
    const { projection, compatibilityTargetKeys, accountSettingsAvailable } = props;
    const providerTargetKey = projection.backendTargetKey;
    const defaultPermissionByTargetKey = settings.sessionDefaultPermissionModeByTargetKey;
    const permissionModeOptions = getPermissionModeOptionsForAgentType(projection.agentId);
    const permissionPreference = providerTargetKey
        ? [providerTargetKey, ...compatibilityTargetKeys]
            .map((targetKey) => readAccountSettingValueForBackendTarget(
                settings,
                'sessionDefaultPermissionModeByTargetKey',
                targetKey as BackendTargetRefV2Input,
            ))
            .find((value) => value !== undefined && value !== null)
        : undefined;
    const permissionMode = isPermissionMode(permissionPreference) ? permissionPreference : 'default';
    const setPermissionMode = (next: PermissionMode) => {
        if (!providerTargetKey || !accountSettingsAvailable) return;
        applySettings({
            sessionDefaultPermissionModeByTargetKey: {
                ...(defaultPermissionByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };
    const showPermissionMode = Boolean(providerTargetKey) && permissionModeOptions.length > 0;
    if (!showPermissionMode && !props.onOpenModels) return null;
    return (
        <ItemGroup
            title={t('settingsAgents.detailPage.sessionDefaultsTitle')}
            description={t('settingsAgents.detailPage.sessionDefaultsAccountDescription', { agent: projection.title })}
        >
            {showPermissionMode ? (
                permissionModeOptions.length <= 4 ? (
                    <SegmentedChoiceItem<PermissionMode>
                        testID="settings.agents.detail.permissionMode"
                        testIDPrefix="settings.agents.detail.permissionMode"
                        title={t('settingsSession.permissions.defaultPermissionModeTitle')}
                        subtitle={t('settingsSession.permissions.backendFooter')}
                        options={permissionModeOptions.map((option) => ({ id: option.value, label: option.label }))}
                        value={permissionMode}
                        disabled={!accountSettingsAvailable}
                        onChange={setPermissionMode}
                    />
                ) : (
                    <DropdownMenu
                        open={permissionMenuOpen}
                        onOpenChange={setPermissionMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={permissionMode}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={props.popoverBoundaryRef}
                        popoverPortalWebTarget="body"
                        itemTrigger={{
                            title: t('settingsSession.permissions.defaultPermissionModeTitle'),
                            subtitle: t('settingsSession.permissions.backendFooter'),
                            itemProps: { disabled: !accountSettingsAvailable, testID: 'settings.agents.detail.permissionMode' },
                        }}
                        items={permissionModeOptions.map((option) => ({
                            id: option.value,
                            title: option.label,
                            subtitle: option.description,
                        }))}
                        onSelect={(id) => {
                            const nextMode = permissionModeOptions.find((option) => option.value === id)?.value;
                            if (nextMode) setPermissionMode(nextMode);
                            setPermissionMenuOpen(false);
                        }}
                    />
                )
            ) : null}
            {props.onOpenModels ? (
                <Item
                    testID="settings.agents.detail.models"
                    icon={<Icon name="stack-simple" />}
                    title={t('settingsProviders.models.manage')}
                    onPress={props.onOpenModels}
                />
            ) : null}
        </ItemGroup>
    );
});

const AgentSettingsFallbackScreenInner = React.memo(function AgentSettingsFallbackScreenInner(props: Readonly<{
    projection: ResolvedAgentCatalogEntry;
    pluginSettingsProjection: PluginProjectionEntry | null;
    targetSelection: MachineAdministrationTargetSelectionV1;
    accountSettingsAvailable: boolean;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    daemonOperationsAvailable: boolean;
    externalSessionsProjectionPhase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    externalSessionsAgent: ExternalSessionsQualifiedAgent | null;
    externalSessionsBrowseAvailable: boolean;
    externalSessionsRefreshKey: string | null;
    machineState: AgentMachineState;
    compatibilityTargetKeys: readonly string[];
    machineLabel: string | null;
    machineOffline: boolean;
    onRetryMachine: () => void;
}>) {
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    }));
    const applySettings = useApplySettings();
    const providerTargetKey = props.projection.backendTargetKey;
    const backendEnabledByTargetKey = settings.backendEnabledByTargetKey;
    const backendEnabled = props.projection.enabled;
    const setBackendEnabled = React.useCallback((next: boolean) => {
        if (!providerTargetKey || !props.accountSettingsAvailable) return;
        applySettings({
            backendEnabledByTargetKey: {
                ...(backendEnabledByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    }, [applySettings, backendEnabledByTargetKey, props.accountSettingsAvailable, providerTargetKey]);
    const machine = props.executionTarget?.machine ?? null;
    const machineLabel = props.machineLabel;

    return (
        <ItemList>
            <AgentMachineContextBar targetSelection={props.targetSelection} />
            <AgentDetailHeader
                projection={props.projection}
                description={describeAgentDetail({
                    agentId: props.projection.agentId,
                    subtitle: props.projection.subtitle,
                    binaryName: null,
                    version: null,
                    cliAvailable: null,
                    channelLabel: props.projection.channel === 'stable'
                        ? null
                        : t(resolveAgentChannelLabelKey(props.projection.channel)),
                    machineLabel,
                })}
                machineId={machine?.id ?? null}
                serverId={props.executionTarget?.serverId ?? null}
                identityCurrent={props.daemonOperationsAvailable}
                enabled={providerTargetKey ? {
                    value: backendEnabled,
                    disabled: !props.accountSettingsAvailable,
                    onChange: setBackendEnabled,
                } : null}
            />
            {props.machineOffline ? <AgentMachineOfflineBanner onRetry={props.onRetryMachine} /> : null}
            {!props.accountSettingsAvailable && props.targetSelection.selectedTarget !== null ? (
                <AgentAttentionBanner
                    testID="settings.agents.detail.accountScope"
                    title={t('connectedServices.accountScopeMismatchTitle')}
                    description={t('connectedServices.accountScopeMismatchDescription')}
                />
            ) : null}
            {props.machineState === 'offline' ? null : (
                <ItemGroup
                    title={t('settingsAgents.detailPage.readinessTitle')}
                    description={t('settingsAgents.detailPage.readinessDescription')}
                >
                    {props.machineState === 'ready' ? (
                        // The machine answered and the agent has no CLI or sign-in to manage there.
                        <Item
                            testID="settings.agents.detail.nothingToSetUp"
                            title={t('settingsAgents.detailPage.nothingToSetUpTitle')}
                            subtitle={t('settingsAgents.detailPage.nothingToSetUpDescription', { agent: props.projection.title })}
                            subtitleLines={0}
                            mode="info"
                        />
                    ) : (
                        <AgentMachineReadinessStateRow
                            state={props.machineState}
                            agentTitle={props.projection.title}
                            machineLabel={props.machineLabel}
                            onRetry={props.onRetryMachine}
                        />
                    )}
                </ItemGroup>
            )}
            <AgentSessionDefaultsSection
                projection={props.projection}
                compatibilityTargetKeys={props.compatibilityTargetKeys}
                accountSettingsAvailable={props.accountSettingsAvailable}
                onOpenModels={null}
            />
            <AgentConnectedAccountPurposeSettingsSection
                projection={props.projection}
                accountSettingsAvailable={props.accountSettingsAvailable}
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
                administrationTarget={props.targetSelection.selectedTarget}
                accountSettingsAvailable={props.accountSettingsAvailable}
            />
            <AgentContributedSettingsSection
                pluginSettingsProjection={props.pluginSettingsProjection}
                targetSelection={props.targetSelection}
                executionTarget={props.executionTarget}
                daemonOperationsAvailable={props.daemonOperationsAvailable}
            />
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
    accountSettingsAvailable: boolean;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    compatibilityTargetKeys: readonly string[];
    pluginSettingsProjection: PluginProjectionEntry | null;
    daemonOperationsAvailable: boolean;
    externalSessionsProjectionPhase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    externalSessionsAgent: ExternalSessionsQualifiedAgent | null;
    externalSessionsBrowseAvailable: boolean;
    externalSessionsRefreshKey: string | null;
    installIntent?: 'install' | 'update';
    machineState: AgentMachineState;
    machineLabel: string | null;
    machineOffline: boolean;
    onRetryMachine: () => void;
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
        accountSettingsAvailable,
        executionTarget,
        compatibilityTargetKeys,
        pluginSettingsProjection,
        daemonOperationsAvailable,
        externalSessionsProjectionPhase,
        externalSessionsAgent,
        externalSessionsBrowseAvailable,
        externalSessionsRefreshKey,
        installIntent,
        machineState,
        machineOffline,
        onRetryMachine,
    } = props;
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
        backendCliSourcePreferenceByTargetKey: settings.backendCliSourcePreferenceByTargetKey,
    }));
    const paneScopeId = React.useMemo(
        () => `settings:provider:${agentId}`,
        [agentId],
    );
    const applySettings = useApplySettings();

    const popoverBoundaryRef = React.useRef<any>(null);

    const agentCli = projection.cli;
    const providerTargetKey = projection.backendTargetKey;
    const backendEnabledByTargetKey = settings.backendEnabledByTargetKey;
    const backendEnabled = projection.enabled;
    const setBackendEnabled = (next: boolean) => {
        if (!providerTargetKey || !accountSettingsAvailable) return;
        applySettings({
            backendEnabledByTargetKey: {
                ...(backendEnabledByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };

    const backendCliSourcePreferenceByTargetKey = settings.backendCliSourcePreferenceByTargetKey;
    const cliSourcePreference = providerTargetKey && agentCli
        ? [providerTargetKey, ...compatibilityTargetKeys]
            .map((targetKey) => readAccountSettingValueForBackendTarget(
                settings,
                'backendCliSourcePreferenceByTargetKey',
                targetKey as BackendTargetRefV2Input,
            ))
            .find((value) => value !== undefined && value !== null)
        : undefined;
    const parsedCliSourcePreference = PluginAgentCliSourcePreferenceSchema.safeParse(cliSourcePreference);
    const providerCliSourcePreference = parsedCliSourcePreference.success
        ? parsedCliSourcePreference.data
        : providerTargetKey && agentCli ? agentCli.executable.sourcePreference : 'system-first';
    const setProviderCliSourcePreference = (next: 'system-first' | 'managed-first') => {
        if (!providerTargetKey || !accountSettingsAvailable) return;
        applySettings({
            backendCliSourcePreferenceByTargetKey: {
                ...(backendCliSourcePreferenceByTargetKey ?? {}),
                [providerTargetKey]: next,
            },
        });
    };

    const supportsResume = supportsCurrentProjectedAgentSessionOpen(currentAgentCapabilities, 'resume');
    const supportsTerminal = supportsCurrentProjectedAgentSurface(currentAgentCapabilities, 'terminal');
    const setupGuideUrl = agentCli?.install.guideUrl ?? agentCli?.install.docsUrl ?? null;

    const primaryMachine = executionTarget?.machine ?? null;
    const capabilityServerId = executionTarget?.serverId ?? null;
    // The one per-machine inventory owner (lab agent-setup): installed, version, sign-in, update.
    const machineAgent = useMachineAgent({
        serverId: capabilityServerId,
        machineId: primaryMachine?.id ?? null,
        agentId: cliAgentId ?? '',
        enabled: Boolean(cliAgentId),
    });
    const providerCliAvailable = machineAgent ? machineAgent.installed : null;
    const primaryMachineLabel = props.machineLabel;
    const headerDescription = describeAgentDetail({
        agentId: projection.agentId,
        subtitle: projection.subtitle,
        binaryName: agentCli?.executable.binaryName ?? null,
        version: machineAgent?.version ?? null,
        cliAvailable: agentCli ? providerCliAvailable : null,
        channelLabel: projection.channel === 'stable' ? null : t(resolveAgentChannelLabelKey(projection.channel)),
        machineLabel: primaryMachineLabel,
    });

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
    const capabilitySummary = capabilityBadges
        .filter((badge) => badge.status === 'positive')
        .map((badge) => badge.label)
        .join(' · ') || t('settingsAgents.notSupported');
    const [capabilitiesExpanded, setCapabilitiesExpanded] = React.useState(false);
    const showCliSourcePreference = supportsDesktopControls && Boolean(agentCli?.install.managed);
    const signInGuideUrl = authPlugin?.docsUrl && authPlugin.docsUrl !== setupGuideUrl
        ? authPlugin.docsUrl
        : null;
    const menuActions = React.useMemo(() => [
        ...(setupGuideUrl ? [{
            id: 'setupGuide',
            title: t('settingsAgents.setupGuideUrlTitle'),
            onSelect: () => { void openExternalUrl(setupGuideUrl); },
        }] : []),
        ...(signInGuideUrl ? [{
            id: 'signInGuide',
            title: t('settingsAgents.detailPage.signInGuide'),
            onSelect: () => { void openExternalUrl(signInGuideUrl); },
        }] : []),
    ], [setupGuideUrl, signInGuideUrl]);

    const main = (
        <ItemList>
            <AgentMachineContextBar targetSelection={targetSelection} />
            <AgentDetailHeader
                projection={projection}
                description={headerDescription}
                machineId={primaryMachine?.id ?? null}
                serverId={capabilityServerId}
                identityCurrent={projection.identity
                    ? daemonOperationsAvailable
                    : projection.isBuiltIn || daemonOperationsAvailable}
                enabled={providerTargetKey ? {
                    value: backendEnabled,
                    disabled: !accountSettingsAvailable,
                    onChange: setBackendEnabled,
                } : null}
                menuActions={menuActions}
            />
            {machineOffline ? (
                <AgentMachineOfflineBanner onRetry={onRetryMachine} />
            ) : null}
            {!accountSettingsAvailable && targetSelection.selectedTarget !== null ? (
                <AgentAttentionBanner
                    testID="settings.agents.detail.accountScope"
                    title={t('connectedServices.accountScopeMismatchTitle')}
                    description={t('connectedServices.accountScopeMismatchDescription')}
                />
            ) : null}
            {machineState === 'none' || machineState === 'checking' || machineState === 'error' ? (
                <ItemGroup
                    title={t('settingsAgents.detailPage.readinessTitle')}
                    description={t('settingsAgents.detailPage.readinessDescription')}
                >
                    <AgentMachineReadinessStateRow
                        state={machineState}
                        agentTitle={projection.title}
                        machineLabel={props.machineLabel}
                        onRetry={onRetryMachine}
                    />
                </ItemGroup>
            ) : primaryMachine && capabilityServerId && cliAgentId ? (
                // The same model and form as the machine's Agents section (lab agent-setup): install,
                // sign in (connected service first, else the agent's own login in the terminal), ready.
                <ItemGroup
                    title={t('settingsAgents.detailPage.readinessTitle')}
                    description={t('settingsAgents.detailPage.readinessDescription')}
                >
                    <MachineAgentReadiness
                        testID="settings.agents.detail.readiness"
                        serverId={capabilityServerId}
                        machineId={primaryMachine.id}
                        machineName={props.machineLabel ?? primaryMachine.id}
                        agentId={cliAgentId}
                        openForm={installIntent !== undefined}
                    />
                </ItemGroup>
            ) : null}

            <AgentSessionDefaultsSection
                projection={projection}
                compatibilityTargetKeys={compatibilityTargetKeys}
                accountSettingsAvailable={accountSettingsAvailable}
                popoverBoundaryRef={popoverBoundaryRef}
                onOpenModels={currentAgentCapabilities && providerTargetKey ? () => router.push({
                    pathname: '/(app)/settings/agents/[agentId]/models',
                    params: {
                        agentId,
                        agentTargetKey: projection.backendTargetKey,
                        pluginId: projection.identity?.pluginId ?? '',
                        runtimeAgentId: '',
                    },
                } as never) : null}
            />

            <AgentConnectedAccountPurposeSettingsSection
                projection={projection}
                accountSettingsAvailable={accountSettingsAvailable}
            />

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
                administrationTarget={targetSelection.selectedTarget}
                accountSettingsAvailable={accountSettingsAvailable}
            />

            <AgentContributedSettingsSection
                pluginSettingsProjection={pluginSettingsProjection}
                targetSelection={targetSelection}
                executionTarget={executionTarget}
                daemonOperationsAvailable={daemonOperationsAvailable}
            />

            {showCliSourcePreference || currentAgentCapabilities ? (
                <ItemGroup title={t('settingsAgents.detailPage.advancedTitle')}>
                    {showCliSourcePreference ? (
                        <SegmentedChoiceItem<'system-first' | 'managed-first'>
                            testID="settings-provider-cli-source-preference"
                            testIDPrefix="settings-provider-cli-source-preference"
                            title={t('settingsAgents.cliSourcePreference.title')}
                            subtitle={t('settingsAgents.cliSourcePreference.subtitle')}
                            options={[
                                { id: 'system-first', label: t('settingsAgents.cliSourcePreference.options.systemFirst.title') },
                                { id: 'managed-first', label: t('settingsAgents.cliSourcePreference.options.managedFirst.title') },
                            ]}
                            value={providerCliSourcePreference}
                            disabled={!accountSettingsAvailable}
                            onChange={setProviderCliSourcePreference}
                        />
                    ) : null}
                    {currentAgentCapabilities ? (
                        <ExpandableItem
                            testID="settings.agents.detail.capabilities"
                            expanded={capabilitiesExpanded}
                            onExpandedChange={setCapabilitiesExpanded}
                            header={(state) => (
                                <Item
                                    {...state.headerProps}
                                    testID="settings.agents.detail.capabilities.header"
                                    title={t('settingsAgents.capabilities')}
                                    detail={capabilitySummary}
                                    showChevron={false}
                                    rightElement={(
                                        <Icon
                                            name={state.expanded ? 'caret-down' : 'caret-right'}
                                            size={16}
                                            color={theme.colors.text.secondary}
                                        />
                                    )}
                                />
                            )}
                        >
                            <BadgeGrid items={capabilityBadges} columns={2} />
                        </ExpandableItem>
                    ) : null}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
    return (
        <View
            ref={popoverBoundaryRef}
            style={{ flex: 1, minHeight: 0 }}
        >
            {/* The agent's own sign-in opens in this page's bottom pane (lab T1); a sheet on phones. */}
            <AgentSignInPaneHost scopeId={paneScopeId} main={main} />
        </View>
    );
});

export const AgentSettingsScreen = React.memo(function AgentSettingsScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
    }));
    const administrationTargetSelection = useAgentsAdministrationTargetSelection();
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
        const serverIdentityId = typeof params.serverIdentityId === 'string'
            ? params.serverIdentityId.trim()
            : '';
        const installIntent =
            params.installIntent === 'update'
                ? 'update'
                : params.installIntent === 'install'
                    ? 'install'
                    : null;
        if (!machineId || !serverIdentityId || !installIntent) {
            return null;
        }
        return { machineId, serverIdentityId, installIntent } as const;
    }, [
        params.installIntent,
        params.machineId,
        params.serverIdentityId,
    ]);
    const recoveryInstallTarget = React.useMemo(() => {
        if (!recoveryInstallRequest) return null;
        const candidate = administrationTargetSelection.candidates.find((entry) => (
            entry.target.machineId === recoveryInstallRequest.machineId
            && entry.target.serverIdentityId === recoveryInstallRequest.serverIdentityId
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
    const machineScope = useAgentsMachineScope(administrationTargetSelection);
    const executionTarget = machineScope.executionTarget;
    const installIntent =
        recoveryInstallTarget
        && executionTarget
        && machineAdministrationTargetsEqual(recoveryInstallTarget.target, executionTarget.target)
            ? recoveryInstallTarget.installIntent
            : undefined;
    // An offline machine keeps its scope so its last known projection stays visible.
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: machineScope.projectionScope?.machineId ?? null,
        serverId: machineScope.projectionScope?.serverId ?? null,
        enabled: machineScope.projectionScope !== null,
    });
    // The hook already fences target and Account scope changes while retaining
    // same-scope LKG inputs through refresh/error. These inputs are inert
    // presentation metadata; effectful daemon operations remain gated on a live target.
    const daemonMergedProjectionInputs = daemonMergedProjection.inputs;
    const retryDaemonProjection = React.useCallback(() => {
        if (!machineScope.projectionScope) return;
        publishMachineContributionRegistryProjectionInvalidation(machineScope.projectionScope);
    }, [machineScope.projectionScope]);
    const legacyCompatAgentRedirectId = React.useMemo(() => resolveLegacyCompatAgentRouteRedirect({
        agentId: hasQualifiedAgentRoute ? '' : normalizedAgentId,
        daemonMergedProjectionInputs,
    }), [daemonMergedProjectionInputs, hasQualifiedAgentRoute, normalizedAgentId]);
    const waitingForLegacyCompatProjection = !hasQualifiedAgentRoute
        && isLegacyCompatAgentType(normalizedAgentId)
        && daemonMergedProjection.phase === 'loading'
        && !daemonMergedProjectionInputs
        && executionTarget !== null;

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
    // The one exact Agent identity this screen addresses, derived once: a
    // qualified route names it outright; otherwise the resolved projection
    // supplies it. Settings and External Sessions bindings compare
    // pluginId+localId so a same-localId Agent in another plugin never wins.
    const resolvedAgentIdentity = resolveAgentDetailQualifiedIdentity({
        routeQualifiedAgent,
        projectionIdentity: projection?.identity ?? null,
    });
    const compatibilityAgentId = projection?.catalogAgentId ?? null;
    const cliAgentId = projection?.cli ? projection.agentId : null;
    const currentAgentCapabilities = React.useMemo(() => readCurrentProjectedAgentCapabilities({
        projection: daemonMergedProjectionInputs?.pluginProjectionV2,
        agentId: resolvedAgentProjectionId,
    }), [
        daemonMergedProjectionInputs?.pluginProjectionV2,
        resolvedAgentProjectionId,
    ]);
    const pluginSettingsProjection = React.useMemo(() => resolveAgentDetailPluginSettingsProjection({
        pluginProjectionById: daemonMergedProjectionInputs?.pluginProjectionById,
        identity: resolvedAgentIdentity,
    }), [
        daemonMergedProjectionInputs?.pluginProjectionById,
        resolvedAgentIdentity,
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
        return resolvedAgentProjectionId && resolvedAgentIdentity
            ? resolveAgentDetailExternalSessionsBinding({
                projection: daemonMergedProjectionInputs?.pluginProjectionV2,
                agentId: resolvedAgentProjectionId,
                identity: resolvedAgentIdentity,
            })
            : null;
    }, [
        daemonMergedProjectionInputs?.pluginProjectionV2,
        resolvedAgentProjectionId,
        resolvedAgentIdentity,
    ]);
    const externalSessionsRefreshKey = externalSessionsBinding
        ? `${externalSessionsBinding.generation}:${executionTarget?.serverId ?? ''}:${executionTarget?.machine.id ?? ''}`
        : null;
    // Agent settings are Account settings: with no machine chosen they belong to the active Account;
    // a machine from another server's Account makes them read-only here.
    const accountSettingsAvailable = administrationTargetSelection.selectedTarget === null
        || administrationTargetSelection.selectedTargetServerMatchesActiveAccount;
    const machineState: AgentMachineState = administrationTargetSelection.selectedTarget === null
        ? 'none'
        : machineScope.offline
            ? 'offline'
            : daemonMergedProjection.phase === 'ready' || daemonMergedProjection.phase === 'unsupported'
                ? 'ready'
                : daemonMergedProjection.phase === 'error'
                    ? 'error'
                    : 'checking';
    // Keep the hook graph stable while the daemon projection advances from its
    // loading state to a resolved compatibility redirect.
    if (waitingForLegacyCompatProjection) {
        return (
            <AgentSettingsProjectionStatus
                phase="loading"
                targetSelection={administrationTargetSelection}
            />
        );
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
    if (!normalizedAgentId) {
        return <AgentSettingsNotFound theme={theme} targetSelection={administrationTargetSelection} />;
    }

    if (!projection) {
        if (daemonMergedProjection.phase === 'ready') {
            return <AgentSettingsNotFound theme={theme} targetSelection={administrationTargetSelection} />;
        }
        return (
            <AgentSettingsProjectionStatus
                phase={daemonMergedProjection.phase}
                targetSelection={administrationTargetSelection}
                onRetry={daemonMergedProjection.phase === 'error' ? retryDaemonProjection : undefined}
            />
        );
    }
    // An agent whose CLI the machine has not declared (no machine, still checking, or genuinely no
    // CLI) gets the page without machine operations; its Account settings still show at once.
    if (!currentAgentCapabilities && !projection.cli) {
        return (
            <AgentSettingsFallbackScreenInner
                machineState={machineState}
                compatibilityTargetKeys={compatibilityTargetKeys}
                projection={projection}
                pluginSettingsProjection={pluginSettingsProjection}
                targetSelection={administrationTargetSelection}
                accountSettingsAvailable={accountSettingsAvailable}
                executionTarget={executionTarget}
                daemonOperationsAvailable={executionTarget !== null && daemonMergedProjection.phase === 'ready'}
                externalSessionsProjectionPhase={daemonMergedProjection.phase}
                externalSessionsAgent={externalSessionsBinding?.agent ?? null}
                externalSessionsBrowseAvailable={externalSessionsBinding?.browseAvailable === true}
                externalSessionsRefreshKey={externalSessionsRefreshKey}
                machineLabel={machineScope.machineLabel}
                machineOffline={machineScope.offline}
                onRetryMachine={retryDaemonProjection}
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
            accountSettingsAvailable={accountSettingsAvailable}
            executionTarget={executionTarget}
            compatibilityTargetKeys={compatibilityTargetKeys}
            pluginSettingsProjection={pluginSettingsProjection}
            daemonOperationsAvailable={executionTarget !== null && daemonMergedProjection.phase === 'ready'}
            externalSessionsProjectionPhase={daemonMergedProjection.phase}
            externalSessionsAgent={externalSessionsBinding?.agent ?? null}
            externalSessionsBrowseAvailable={externalSessionsBinding?.browseAvailable === true}
            externalSessionsRefreshKey={externalSessionsRefreshKey}
            installIntent={installIntent}
            machineState={machineState}
            machineLabel={machineScope.machineLabel}
            machineOffline={machineScope.offline}
            onRetryMachine={retryDaemonProjection}
        />
    );
});
