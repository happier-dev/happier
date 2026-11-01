import React from 'react';
import { useAgentPreferenceWriter } from './useAgentPreferenceWriter';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { AGENT_SETTINGS } from './agentsSettings';
import { View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import { useExactModelChoice } from '@/components/sessions/modelPicker/useExactModelChoice';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { AgentDetailHeader, AgentMachineContextBar } from '@/components/settings/agents/detail/AgentDetailHeader';
import { AgentAttentionBanner } from '@/components/settings/agents/detail/AgentAttentionBanner';
import {
    resolveAgentsMachineCandidateAvailability,
    useAgentsAdministrationTargetSelection,
    useAgentsMachineScope,
} from '@/components/settings/agents/collection/useAgentAdministrationCatalog';
import { AgentMachinesSection } from '@/components/settings/agents/detail/AgentMachinesSection';
import { AgentIdleCompactionRows, resolveIdleCompactionDeclaration } from '@/components/settings/agents/detail/AgentIdleCompactionRows';
import type { AgentSessionCompactionCapability } from '@happier-dev/protocol/plugins/agents';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { BadgeGrid, type BadgeGridItem } from '@/components/ui/layout/BadgeGrid';
import { useSetting, useSettingsSelector } from '@/sync/domains/state/storage';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProviderSettings } from '@/providers/hooks/useProviderSettings';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { providerModelConnectionTitle } from '@/providers/models/providerModelConnectionTitle';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { ConnectedAccountActionApprovalNotice } from '@/components/settings/connectedServices/ConnectedAccountActionApprovalNotice';
import { Modal } from '@/modal';
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
import { AgentSignInPaneHost } from '@/components/machines/agents/AgentSignInPaneHost';
import { resolveAgentChannelLabelKey } from '@/components/settings/agents/agentChannelLabel';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { isPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginAgentCliSourcePreferenceSchema } from '@happier-dev/protocol/plugins/contributions/agentCliMetadata';
import { readAccountSettingValueForBackendTarget } from '@happier-dev/protocol/account/settings/accountSettings';
import { qualifiedPurposeKey, type QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { resolveAgentConnectedAccountPurposeDefaults, type AgentConnectedAccountPurposeTeamResourceDefault } from '@happier-dev/protocol/account/settings/connected-services';
import type { PluginProjectedAgentConnectedAccountPurposeV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { buildBackendTargetKey } from '@happier-dev/protocol/backends/targets/backendTargetRef';
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
import {
    type FreshMachineAdministrationExecutionTargetV1,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isAdministrationScopedPluginSettingsTargetCurrent } from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';
import { AgentContributedSettingsSection, areAgentAccountSettingsAvailable } from './AgentContributedSettingsSection';
import { resolveAgentNativeModels, summarizeAgentModelVisibility } from './agentModelVisibility';
import { getFavoriteModelRef } from '@/sync/domains/models/favoriteModelSelections';

export { AgentContributedSettingsSection } from './AgentContributedSettingsSection';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjection';
import { readMachineAdministrationTargetRouteParams } from '@/sync/domains/machines/administration/targetSelection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

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
 * The one line under an agent's name, all Account facts: what it is, whether new sessions use it,
 * and a non-stable release channel. Its CLI and version belong to each computer it runs on, so they
 * live in "On your machines".
 */
function describeAgentDetail(params: Readonly<{
    enabled: boolean | null;
    channelLabel: string | null;
}>): string {
    return [
        t('settingsAgents.detailPage.kindCodingAgent'),
        params.enabled ? t('settingsAgents.detailPage.usedByNewSessions') : null,
        params.channelLabel,
    ].filter(Boolean).join(' · ');
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
                    <Text style={{  ...Typography.variant('heading'), color: props.theme.colors.state.danger.foreground, textAlign: 'center', marginBottom: 8 }}>
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

/** The agent's default account per purpose, as rows of its Session defaults (Account settings). */
const AgentConnectedAccountPurposeRows = React.memo(function AgentConnectedAccountPurposeRows(
    props: Readonly<{
        projection: ResolvedAgentCatalogEntry;
        accountSettingsAvailable: boolean;
        machineId?: string;
    }>,
) {
    const { catalog: purposeCatalog, legacySettings, mutateDefaults, execution } = useConnectedAccountPurposeDefaults();
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
        machineId: props.machineId ?? null,
        enabled: teamCredentialResourcesEnabled && declarations.length > 0,
    });
    // The one Agent default-authentication owner reads and writes these
    // purpose defaults; a released service-keyed default is shown until the
    // first write folds it into the purpose-binding store.
    const defaultsByPurposeKey = React.useMemo(() => new Map(
        identity && purposeCatalog.value
            ? resolveAgentConnectedAccountPurposeDefaults({
                settings: legacySettings,
                purposeBindings: purposeCatalog.value,
                agentId: props.projection.agentId,
                consumer: identity,
                declarations,
            }).map((entry) => [qualifiedPurposeKey(entry.purpose), entry] as const)
            : [],
    ), [declarations, legacySettings, purposeCatalog.value, identity, props.projection.agentId]);
    // A Team resource choice is written as the canonical Team selection of its
    // Team (lane 10 child 02 :271, child 06 :506), never as a purpose target.
    const setTarget = React.useCallback((
        declaration: PluginProjectedAgentConnectedAccountPurposeV2,
        target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
        teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null,
    ) => {
        // A refresh keeps the last-known catalog: the write owner refuses a stale catalog itself, and says so.
        if (!identity || !props.accountSettingsAvailable || purposeCatalog.value === null) return;
        void mutateDefaults({ kind: 'service', input: {
            agentId: props.projection.agentId,
            service: declaration.service,
            purpose: declaration.purpose,
            selection: teamResource?.selection ?? (target?.kind === 'account'
                ? { source: 'connected', selection: 'profile', profileId: target.account.accountId }
                : target?.kind === 'group'
                    ? { source: 'connected', selection: 'group', groupId: target.groupId }
                    : { source: 'native' }),
            ...(teamResource ? { teamId: teamResource.teamId } : {}),
            ...(props.machineId ? { machineId: props.machineId } : {}),
        } }).catch(() => Modal.alert(t('common.error'), t('widgetAdd.inputsUnavailable')));
    }, [mutateDefaults, purposeCatalog.value, identity, props.accountSettingsAvailable, props.projection.agentId, props.machineId]);

    if (!identity || declarations.length === 0) return null;
    return (
        <>
            <ConnectedAccountActionApprovalNotice execution={execution} testID="agent-connected-account-purpose-approval-pending" />
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
                        noneLabel={t('connectedServices.purposeTargets.ownSignIn', { agent: props.projection.title })}
                        onReload={teamCredentialCatalog.reload}
                        // Last-known defaults stay shown and choosable while the catalog refreshes; only a
                        // catalog never read (or withdrawn) says Loading / Unavailable.
                        disabled={!props.accountSettingsAvailable || purposeCatalog.value === null}
                        disabledReason={!props.accountSettingsAvailable
                            ? t('connectedServices.accountScopeMismatchDescription')
                            : purposeCatalog.value === null
                                ? t(purposeCatalog.status === 'loading' ? 'common.loading' : 'common.unavailable')
                                : undefined}
                        onChange={(target, teamResource) => setTarget(declaration, target, teamResource)}
                    />
                );
            })}
        </>
    );
});

/**
 * Session defaults are Account settings keyed by the agent's backend target: they load and save
 * with no machine, and apply on every machine a new session starts on. The default account for
 * each of the agent's purposes and the way to its Models page sit here too, for the same reason.
 */
export const AgentSessionDefaultsSection = React.memo(function AgentSessionDefaultsSection(props: Readonly<{
    projection: ResolvedAgentCatalogEntry;
    compatibilityTargetKeys: readonly string[];
    accountSettingsAvailable: boolean;
    machineId?: string;
    /** The popover boundary the dropdown form of the permission choice measures against. */
    popoverBoundaryRef?: React.ComponentProps<typeof DropdownMenu>['popoverBoundaryRef'];
    onOpenModels: (() => void) | null;
    /** An installed Agent's current compaction declaration; bundled Agents publish theirs per runtime kind. */
    projectedCompaction?: AgentSessionCompactionCapability | null;
    /** The daemon projection the Agent's own plugin settings (its runtime choice) are declared in. */
    projectionInputs?: DaemonMergedProjectionInputs | null;
}>) {
    const sessionDefaultPermissionModeByTargetKey = useSetting('sessionDefaultPermissionModeByTargetKey');
    const writePreference = useAgentPreferenceWriter();
    const [permissionMenuOpen, setPermissionMenuOpen] = React.useState(false);
    const { projection, compatibilityTargetKeys, accountSettingsAvailable } = props;
    const providerTargetKey = projection.backendTargetKey;
    const providersEnabled = useFeatureEnabled('providers');
    const providerSettings = useProviderSettings(accountSettingsAvailable ? undefined : null);
    const accountScope = useAccountSettingsScope();
    const defaultSelection = providerTargetKey ? providerSettings.defaultsByAgentTargetKey[providerTargetKey] ?? null : null;
    // The Models row says what the picker shows; both reads are the Account's, with no machine.
    const summarizeModels = Boolean(providersEnabled && accountSettingsAvailable && props.onOpenModels);
    const favorites = useSetting('currentFavoriteModelSelectionsV1');
    const favoriteSelections = React.useMemo(() => favorites.map(getFavoriteModelRef)
        .filter(ref => ref.agentTargetKey === providerTargetKey), [favorites, providerTargetKey]);
    const models = useProviderModelProjection({
        enabled: summarizeModels,
        machineId: null,
        serverId: accountScope?.serverId ?? null,
        agentTargetKey: providerTargetKey,
        mode: 'management',
        ...(defaultSelection ? { currentSelection: defaultSelection.ref } : {}),
    });
    const pickerModels = useProviderModelProjection({
        enabled: summarizeModels,
        machineId: null,
        serverId: accountScope?.serverId ?? null,
        agentTargetKey: providerTargetKey,
        mode: 'picker',
        ...(defaultSelection ? { currentSelection: defaultSelection.ref } : {}),
        favoriteSelections,
    });
    const nativeAgentId = resolveBundledAgentIdFromContributionIdentity(projection.identity);
    // D22: the Account default model, model only (no Account-level effort default exists). Written
    // through `providers.defaults.set`; it needs no computer.
    const accountServerId = accountScope?.serverId ?? null;
    const defaultModelTitle = t('agentInput.model.title');
    const defaultModelChoice = useExactModelChoice({
        agentTargetKey: providerTargetKey,
        agentId: nativeAgentId,
        machineId: null,
        serverId: accountServerId,
        selected: defaultSelection?.ref ?? null,
        title: defaultModelTitle,
        fallbackLabel: t('settingsAgents.detailPage.defaultModelAgentDefault'),
        clearOptionLabel: t('settingsAgents.detailPage.defaultModelAgentDefault'),
        clearOptionDescription: t('settingsAgents.detailPage.defaultModelAgentDefaultDescription'),
        enabled: Boolean(providersEnabled && accountSettingsAvailable && providerTargetKey),
    });
    const { setProviderDefaultModelSelection } = useProviderActionClient(accountServerId);
    const [defaultModelError, setDefaultModelError] = React.useState<Readonly<{ error: ProviderErrorV1; retry: () => Promise<void> }> | null>(null);
    const writeDefaultModel = React.useCallback(async (ref: ProviderBoundModelRef | null): Promise<void> => {
        if (!providerTargetKey || !accountSettingsAvailable) return;
        try {
            await setProviderDefaultModelSelection({
                serverId: accountServerId,
                agentTargetKey: providerTargetKey,
                selection: ref ? { v: 1, ref, updatedAt: Date.now() } : null,
            });
            setDefaultModelError(null);
        } catch (caught) {
            setDefaultModelError({ error: providerErrorFromRpcFailure(caught), retry: () => writeDefaultModel(ref) });
        }
    }, [accountServerId, accountSettingsAvailable, providerTargetKey, setProviderDefaultModelSelection]);
    const openDefaultModel = defaultModelChoice.open;
    const chooseDefaultModel = React.useCallback(() => openDefaultModel((ref) => { void writeDefaultModel(ref); }),
        [openDefaultModel, writeDefaultModel]);
    const { theme } = useUnistyles();
    const defaultModelField = renderDropdownItemTriggerRightElement({
        detail: defaultSelection ? defaultModelChoice.presentation.subtitle ?? null : null,
        open: false,
        detailColor: theme.colors.text.primary,
        chevronColor: theme.colors.text.secondary,
        field: resolveFieldBoxColors(theme),
        placeholder: t('settingsAgents.detailPage.defaultModelAgentDefault'),
        secondary: defaultSelection ? defaultModelChoice.presentation.detail ?? null : null,
        secondaryColor: theme.colors.text.secondary,
        // A page field: it spans the column it sits in, beside the label or beneath it on a phone.
        fieldSpan: 'column',
        // A source's model is named only once its projection answers; until then the field keeps its
        // place with its own quiet bar (no spinner beside it, and the row stays openable).
        loading: Boolean(defaultSelection?.ref.providerConnectionId) && defaultModelChoice.loading,
    });
    const nativeModels = React.useMemo(() => providerTargetKey ? resolveAgentNativeModels({
        runtimeAgentId: nativeAgentId,
        agentTargetKey: providerTargetKey,
        modelVisibilityByRef: providerSettings.modelVisibilityByRef,
    }) : [], [nativeAgentId, providerSettings.modelVisibilityByRef, providerTargetKey]);
    const visibilitySummary = summarizeModels && models.data && pickerModels.data
        ? summarizeAgentModelVisibility({
            nativeModels,
            pickerGroups: pickerModels.data.groups,
            managementGroups: models.data.groups,
        })
        : null;
    const permissionModeOptions = getPermissionModeOptionsForAgentType(projection.agentId, 'settings');
    const permissionPreference = providerTargetKey
        ? [providerTargetKey, ...compatibilityTargetKeys]
            .map((targetKey) => readAccountSettingValueForBackendTarget(
                { sessionDefaultPermissionModeByTargetKey },
                'sessionDefaultPermissionModeByTargetKey',
                targetKey as BackendTargetRefV2Input,
            ))
            .find((value) => value !== undefined && value !== null)
        : undefined;
    const permissionMode = isPermissionMode(permissionPreference) ? permissionPreference : 'default';
    const setPermissionMode = (next: PermissionMode) => {
        if (!providerTargetKey || !accountSettingsAvailable) return;
        void writePreference('defaultPermission', providerTargetKey, next);
    };
    const showPermissionMode = Boolean(providerTargetKey) && permissionModeOptions.length > 0;
    const hasAccountRows = Boolean(projection.identity) && (projection.connectedAccounts?.length ?? 0) > 0;
    // Shown when the Agent declares idle compaction in any runtime mode; the rows pick the configured one.
    const idleCompactionRows = providerTargetKey && resolveIdleCompactionDeclaration({
        bundledAgentId: nativeAgentId, configuredRuntimeKind: null, projectedCompaction: props.projectedCompaction,
    }) ? (
        <AgentIdleCompactionRows
            agentTargetKey={providerTargetKey}
            compatibilityTargetKeys={compatibilityTargetKeys}
            bundledAgentId={nativeAgentId}
            projectedCompaction={props.projectedCompaction}
            accountSettingsAvailable={accountSettingsAvailable}
            machineId={props.machineId}
            accountServerId={accountServerId}
            projectionInputs={props.projectionInputs}
            popoverBoundaryRef={props.popoverBoundaryRef}
        />
    ) : null;
    if (!showPermissionMode && !props.onOpenModels && !hasAccountRows && !idleCompactionRows) return null;
    return (
        <ItemGroup
            title={t('settingsAgents.detailPage.sessionDefaultsTitle')}
            description={t('settingsAgents.detailPage.sessionDefaultsSavedDescription', { agent: projection.title })}
        >
            {showPermissionMode ? (
                <SettingAnchor setting={AGENT_SETTINGS.settings.defaultPermission}>{permissionModeOptions.length <= 4 ? (
                    <SegmentedChoiceItem<PermissionMode>
                        testID="settings.agents.detail.permissionMode"
                        testIDPrefix="settings.agents.detail.permissionMode"
                        title={t('settingsSession.permissions.defaultPermissionModeTitle')}
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
                )}</SettingAnchor>
            ) : null}
            <AgentConnectedAccountPurposeRows
                projection={projection}
                accountSettingsAvailable={accountSettingsAvailable}
                machineId={props.machineId}
            />
            {providersEnabled && providerTargetKey ? (
                <SettingAnchor setting={AGENT_SETTINGS.settings.defaultModel}><Item
                    testID="settings.agents.detail.defaultModel"
                    title={defaultModelTitle}
                    accessibilityLabel={(defaultSelection ? defaultModelChoice.presentation.accessibilityLabel : undefined)
                        ?? `${defaultModelTitle}: ${defaultSelection ? defaultModelChoice.presentation.subtitle ?? '' : t('settingsAgents.detailPage.defaultModelAgentDefault')}`}
                    accessoryLayout="adaptive"
                    fieldAccessory
                    showChevron={false}
                    rightElement={defaultModelField}
                    disabled={!accountSettingsAvailable}
                    onPress={chooseDefaultModel}
                /></SettingAnchor>
            ) : null}
            {defaultModelError ? (
                <ProviderErrorItems error={defaultModelError.error} retry={defaultModelError.retry} />
            ) : null}
            {idleCompactionRows}
            {props.onOpenModels ? (
                <SettingRow setting={AGENT_SETTINGS.settings.models}
                    testID="settings.agents.detail.models"
                    detail={visibilitySummary
                        ? t('settingsAgents.detailPage.modelsVisibilitySummary', visibilitySummary)
                        : undefined}
                    onPress={props.onOpenModels}
                />
            ) : null}
        </ItemGroup>
    );
});

const AgentSettingsFallbackScreenInner = React.memo(function AgentSettingsFallbackScreenInner(props: Readonly<{
    projection: ResolvedAgentCatalogEntry;
    pluginSettingsProjection: PluginProjectionEntry | null;
    projectionInputs: DaemonMergedProjectionInputs | null;
    targetSelection: MachineAdministrationTargetSelectionV1;
    accountSettingsAvailable: boolean;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    daemonOperationsAvailable: boolean;
    externalSessionsProjectionPhase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    externalSessionsAgent: ExternalSessionsQualifiedAgent | null;
    externalSessionsBrowseAvailable: boolean;
    externalSessionsRefreshKey: string | null;
    compatibilityTargetKeys: readonly string[];
    accountServerId: string | null;
}>) {
    const writePreference = useAgentPreferenceWriter();
    const providerTargetKey = props.projection.backendTargetKey;
    const router = useRouter();
    const providersEnabled = useFeatureEnabled('providers');
    const backendEnabled = props.projection.enabled;
    const setBackendEnabled = React.useCallback((next: boolean) => {
        if (!providerTargetKey || !props.accountSettingsAvailable) return;
        void writePreference('enabled', providerTargetKey, next);
    }, [writePreference, props.accountSettingsAvailable, providerTargetKey]);
    const machine = props.executionTarget?.machine ?? null;

    return (
        <ItemList>
            <AgentDetailHeader
                projection={props.projection}
                description={describeAgentDetail({
                    enabled: backendEnabled,
                    channelLabel: props.projection.channel === 'stable'
                        ? null
                        : t(resolveAgentChannelLabelKey(props.projection.channel)),
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
            {!props.accountSettingsAvailable && props.targetSelection.selectedTarget !== null ? (
                <AgentAttentionBanner
                    testID="settings.agents.detail.accountScope"
                    title={t('connectedServices.accountScopeMismatchTitle')}
                    description={t('connectedServices.accountScopeMismatchDescription')}
                />
            ) : null}
            {props.accountServerId ? (
                <AgentMachinesSection
                    testID="settings.agents.detail.machines"
                    agentTitle={props.projection.title}
                    agentId={props.projection.agentId}
                    pinnedVersion={null}
                    serverId={props.accountServerId}
                    targetSelection={props.targetSelection}
                />
            ) : null}
            <AgentSessionDefaultsSection
                projection={props.projection}
                compatibilityTargetKeys={props.compatibilityTargetKeys}
                accountSettingsAvailable={props.accountSettingsAvailable}
                machineId={props.executionTarget?.machine.id}
                projectionInputs={props.projectionInputs}
                onOpenModels={providersEnabled && providerTargetKey ? () => router.push({
                    pathname: '/(app)/settings/agents/[agentId]/models',
                    params: {
                        agentId: props.projection.agentId,
                        agentTargetKey: providerTargetKey,
                        pluginId: props.projection.identity?.pluginId ?? '',
                        runtimeAgentId: resolveBundledAgentIdFromContributionIdentity(props.projection.identity) ?? '',
                    },
                } as never) : null}
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
    projection: ResolvedAgentCatalogEntry;
    currentAgentCapabilities: CurrentProjectedAgentCapabilities | null;
    authPlugin: ResolvedAgentCatalogEntry['authPlugin'];
    targetSelection: MachineAdministrationTargetSelectionV1;
    accountSettingsAvailable: boolean;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    compatibilityTargetKeys: readonly string[];
    pluginSettingsProjection: PluginProjectionEntry | null;
    projectionInputs: DaemonMergedProjectionInputs | null;
    daemonOperationsAvailable: boolean;
    externalSessionsProjectionPhase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    externalSessionsAgent: ExternalSessionsQualifiedAgent | null;
    externalSessionsBrowseAvailable: boolean;
    externalSessionsRefreshKey: string | null;
    /** The Account's server: the machines listed in "On your machines". */
    accountServerId: string | null;
    /** A route that names one machine (a recovery) opens that machine's row. */
    recoveryMachineId: string | null;
}>) {
    const router = useRouter();
    const supportsDesktopControls = isDesktopHost();
    const {
        agentId,
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
        accountServerId,
        recoveryMachineId,
    } = props;
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
        backendCliSourcePreferenceByTargetKey: settings.backendCliSourcePreferenceByTargetKey,
    }));
    const paneScopeId = React.useMemo(
        () => `settings:provider:${agentId}`,
        [agentId],
    );
    const writePreference = useAgentPreferenceWriter();

    const popoverBoundaryRef = React.useRef<any>(null);

    const agentCli = projection.cli;
    const providerTargetKey = projection.backendTargetKey;
    const backendEnabled = projection.enabled;
    const setBackendEnabled = (next: boolean) => {
        if (!providerTargetKey || !accountSettingsAvailable) return;
        void writePreference('enabled', providerTargetKey, next);
    };

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
        void writePreference('executableSource', providerTargetKey, next);
    };

    const supportsResume = supportsCurrentProjectedAgentSessionOpen(currentAgentCapabilities, 'resume');
    const supportsTerminal = supportsCurrentProjectedAgentSurface(currentAgentCapabilities, 'terminal');
    const setupGuideUrl = agentCli?.install.guideUrl ?? agentCli?.install.docsUrl ?? null;

    const primaryMachine = executionTarget?.machine ?? null;
    const capabilityServerId = executionTarget?.serverId ?? null;
    const headerDescription = describeAgentDetail({
        enabled: backendEnabled,
        channelLabel: projection.channel === 'stable' ? null : t(resolveAgentChannelLabelKey(projection.channel)),
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
            {!accountSettingsAvailable && targetSelection.selectedTarget !== null ? (
                <AgentAttentionBanner
                    testID="settings.agents.detail.accountScope"
                    title={t('connectedServices.accountScopeMismatchTitle')}
                    description={t('connectedServices.accountScopeMismatchDescription')}
                />
            ) : null}

            {accountServerId ? (
                <AgentMachinesSection
                    testID="settings.agents.detail.machines"
                    agentTitle={projection.title}
                    agentId={projection.agentId}
                    pinnedVersion={null}
                    serverId={accountServerId}
                    targetSelection={targetSelection}
                    initialExpandedMachineId={recoveryMachineId}
                />
            ) : null}

            <AgentSessionDefaultsSection
                projection={projection}
                compatibilityTargetKeys={compatibilityTargetKeys}
                accountSettingsAvailable={accountSettingsAvailable}
                machineId={primaryMachine?.id}
                popoverBoundaryRef={popoverBoundaryRef}
                projectionInputs={props.projectionInputs}
                onOpenModels={providerTargetKey ? () => router.push({
                    pathname: '/(app)/settings/agents/[agentId]/models',
                    params: {
                        agentId,
                        agentTargetKey: projection.backendTargetKey,
                        pluginId: projection.identity?.pluginId ?? '',
                        runtimeAgentId: '',
                    },
                } as never) : null}
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
                        <SettingAnchor setting={AGENT_SETTINGS.settings.executableSource}><SegmentedChoiceItem<'system-first' | 'managed-first'>
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
                        /></SettingAnchor>
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
                                    rightElement={<ExpandableItemCaret expanded={state.expanded} />}
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
    }));
    const administrationTargetSelection = useAgentsAdministrationTargetSelection(
        params.machineId !== undefined || params.serverIdentityId !== undefined ? params : undefined,
    );
    // "On your machines" lists the machines of the active server's Account.
    const activeServer = useActiveServerSnapshot();
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

    // A route that names a machine (a recovery sending the person here to install, update or sign in)
    // opens that machine's row.
    const recoveryRequest = React.useMemo(
        () => readMachineAdministrationTargetRouteParams(params),
        [params.machineId, params.serverIdentityId],
    );
    const recoveryInstallTarget = React.useMemo(() => {
        if (!recoveryRequest) return null;
        const state = administrationTargetSelection.state;
        if (state.kind !== 'online' && state.kind !== 'offline') return null;
        return state.target.machineId === recoveryRequest.machineId
            && areServerProfileIdentifiersEquivalent(state.target.serverIdentityId, recoveryRequest.serverIdentityId)
            ? { target: state.target }
            : null;
    }, [administrationTargetSelection.state, recoveryRequest]);
    const machineScope = useAgentsMachineScope(administrationTargetSelection);
    const executionTarget = machineScope.executionTarget;
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
        mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
    }), [
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
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
    const accountSettingsAvailable = areAgentAccountSettingsAvailable(administrationTargetSelection);
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
                projectionInputs={daemonMergedProjectionInputs ?? null}
                accountServerId={activeServer.serverId || null}
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
            />
        );
    }

    return (
        <AgentSettingsScreenInner
            projectionInputs={daemonMergedProjectionInputs ?? null}
            agentId={resolvedAgentProjectionId ?? normalizedAgentId}
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
            accountServerId={activeServer.serverId || null}
            recoveryMachineId={recoveryInstallTarget?.target.machineId ?? null}
        />
    );
});
