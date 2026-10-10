import React from 'react';
import { presentSessionRouteChip, resolveSessionRoutePresentation, projectProviderRouteSignInPurposes, readProviderConnectionDisclosureSource, providerConnectionSourceLabel, type RouteSelection, type ProviderRouteSource, type SessionRoutePresentationInput } from '@/providers/session/resolveSessionRoutePresentation';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';

import { t } from '@/text';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { createConnectedServicesAuthActionChip } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import {
  resolveConnectedServiceProfileActionRoute,
} from '@/sync/domains/connectedServices/resolveConnectedServiceProfileActionRoute';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { FeatureDecisionScopeParams } from '@/hooks/server/useFeatureDecision';
import { useProfile } from '@/sync/store/hooks';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { ConnectedAccountCatalogOperationError } from '@/sync/api/account/apiConnectedAccountCatalog';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { AgentCore } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings, resolveAgentConnectedAccountPurposeDefaults, type ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol/account/settings/connected-services';
import type { ConnectedAccountServiceKey, ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PluginProjectedAgentConnectedAccountPurposeV2, PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ProviderSettingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { useTeamCredentialSelectionCoordinator } from '@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import {
  resolveQualifiedConnectedServiceRegistryDisplayName,
} from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import {
  resolveConnectedServicesAuthLabel,
  resolveConnectedServicesAuthWarningTranslationKey,
  type ConnectedServicesAuthWarningCode,
} from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import {
  CONNECTED_SERVICES_BINDINGS_KEY,
  teamResourceConnectedServiceSelectionKey,
  type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { getQualifiedConnectedServiceRegistryEntry, projectConnectedServiceRegistryEntries } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
  applyProjectedCredentialKindRestrictions,
  buildQualifiedConnectedAccountGroupOptionsByServiceId,
  buildQualifiedConnectedAccountProfileOptionsByServiceId,
  resolveProjectedConnectedAccountServiceKeys,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import {
  buildConnectedServicesBindingsPayload,
  projectSessionCredentialSignInPurposes,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { projectMachineAgentForCredential } from '@/agents/machineAgents/machineAgentModel';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import type { AttentionBannerAction } from '@/components/ui/lists/AttentionBanner';

export type NewSessionConnectedServicesResult = Readonly<{
  routePresentation: ReturnType<typeof resolveSessionRoutePresentation>;
  requesterSignInPurposes: readonly string[];
  connectedAccountDefaultsStatus: 'loading' | 'ready' | 'unavailable';
  requireConnectedAccountDefaultsReady: () => void;
  connectedServicesBindingsPayload: ConnectedServiceBindingsV2 | null;
  connectedServicesModelProbeCacheIdentity: string | null;
  connectedServicesAuthChip: AgentInputExtraActionChip | null;
  selectedCredentialMachineAgent: MachineAgent | null;
  connectedServicesRecoveryAction: AttentionBannerAction | null;
}>;

function resolveDefaultAuthWarningLabel(warningCode: ConnectedServicesAuthWarningCode | undefined): string | undefined {
  const key = resolveConnectedServicesAuthWarningTranslationKey(warningCode);
  return key ? t(key) : undefined;
}


export function useNewSessionConnectedServices(params: Readonly<{
  modelSelection?: RouteSelection;
  providerSources?: readonly ProviderRouteSource[];
  modelRouteTeamSources?: SessionRoutePresentationInput['teamSources'];
  providerSettings?: Pick<ProviderSettingsV1, 'connections' | 'secretBindingsByConnectionId'>;
  providerProjection?: PluginProjectionV2 | null;
  /** Bundled Agent core when the selection targets a bundled Agent; null for installed external Agents. */
  agentCore: Pick<AgentCore, 'id' | 'connectedServices'> | null;
  /**
   * Canonical routing identity of the selected Agent. Installed Agent routing
   * ids are qualified; bundled ids retain their released scalar spelling.
   */
  defaultAuthAgentId?: string | null;
  /**
   * The Agent's contribution identity: the consumer of its declared purposes,
   * which keys its Agent default authentication (the purpose-binding store the
   * Agent page writes). Without it the Agent has no readable default.
   */
  defaultAuthConsumer?: PluginContributionIdentityV1 | null;
  /**
   * Exact Connected Account declarations from the authoritative machine Agent
   * catalog projection. Supported services are the canonical qualified keys of
   * these declarations — never a bundled scalar enum.
   */
  connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
  agentOptionState: Record<string, unknown> | null;
  machineAgent?: MachineAgent | null;
  settings: {
    connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
    /** Released service-keyed defaults, read only until their Agent is rewritten. */
    connectedServicesDefaultAuthByAgentIdV1?: ConnectedServicesDefaultAuthByAgentIdV1;
    connectedServicesAdditionalDefaultAuthByAgentIdV1?: ConnectedServicesDefaultAuthByAgentIdV1;
  };
  targetServerId: string | null;
  /** Explicit selected Machine used only to qualify retained purpose defaults before row activation. */
  sourceMachineId?: string | null;
  /**
   * Publish a payload even when every service resolves to native.
   *
   * New Session omits it: no payload means "nothing authored here". A surface
   * that authors an explicit override needs the opposite — choosing native for
   * every service is a real authored choice to use no connected account, and
   * collapsing it to omission would silently restore inheritance.
   */
  emitWhenAllNative?: boolean;
  teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
  teamCredentialResourceCurrentKeys?: ReadonlySet<string>;
  teamNameById?: Readonly<Record<string, string>>;
  router: { push: (path: any) => void };
  setAgentOptionStateForCurrentAgent: (key: string, value: unknown) => void;
  applyTeamCredentialPolicy?: (
    resource: TeamCredentialResourceCatalogEntryV1,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
}>): NewSessionConnectedServicesResult {
  const { agentCore, connectedAccounts, agentOptionState, settings, targetServerId, router, setAgentOptionStateForCurrentAgent } = params;
  const accountProfile = useProfile();
  const activeScope = useActiveServerAccountScope();
  const { binding } = useServerCredentialAccountScopeBinding(connectedAccounts.length > 0 ? targetServerId : null);
  const focusedPurposeScope = selectActiveServerAccountScopeForServer(activeScope, targetServerId);
  const purposeScope = binding?.isCurrent()
    && (!focusedPurposeScope || areServerAccountScopesEqual(focusedPurposeScope, binding.scope))
    ? binding.scope : null;
  const defaultAuthAgentId = params.defaultAuthAgentId?.trim() ?? agentCore?.id.trim() ?? '';
  const defaultAuthConsumer = params.defaultAuthConsumer ?? null;
  const authoredContextKey = JSON.stringify([activeScope, targetServerId, defaultAuthAgentId, defaultAuthConsumer]);
  const [optimisticAuthored, setOptimisticAuthored] = React.useState<Readonly<{
    contextKey: string; options: Record<string, unknown> | null;
  }> | null>(null);
  const hasControlledBindings = Boolean(agentOptionState && Object.prototype.hasOwnProperty.call(agentOptionState, CONNECTED_SERVICES_BINDINGS_KEY));
  const hasOptimisticBindings = optimisticAuthored?.contextKey === authoredContextKey && optimisticAuthored.options === agentOptionState;
  const hasExplicitBindings = hasControlledBindings || hasOptimisticBindings;
  const inheritsPurposeDefaults = connectedAccounts.length > 0 && !hasExplicitBindings;
  const purposeCatalog = useConnectedAccountCatalog('purposes', inheritsPurposeDefaults ? purposeScope : null,
    { sourceMachineId: params.sourceMachineId });
  const connectedAccountDefaultsStatus: NewSessionConnectedServicesResult['connectedAccountDefaultsStatus'] = !inheritsPurposeDefaults
    ? 'ready'
    : !purposeScope || !defaultAuthAgentId || !defaultAuthConsumer
      ? 'unavailable'
      : purposeCatalog.status === 'ready' && !purposeCatalog.stale && purposeCatalog.value
        ? 'ready'
        : purposeCatalog.status === 'loading' ? 'loading' : 'unavailable';
  const requireConnectedAccountDefaultsReady = React.useCallback(() => {
    if (hasOptimisticBindings && !areServerAccountScopesEqual(getActiveServerAccountScope(), activeScope)) {
      throw new ConnectedAccountCatalogOperationError('connected_account_purpose_catalog_unavailable');
    }
    if (!inheritsPurposeDefaults) return;
    const currentFocusedScope = selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), targetServerId);
    const current = getConnectedAccountCatalogValue(purposeScope, 'purposes');
    if (connectedAccountDefaultsStatus !== 'ready'
      || !binding?.isCurrent()
      || (currentFocusedScope && !areServerAccountScopesEqual(currentFocusedScope, purposeScope))
      || current.status !== 'ready' || current.stale || !current.value
      || current.revision !== purposeCatalog.revision || current.value !== purposeCatalog.value) {
      throw new ConnectedAccountCatalogOperationError('connected_account_purpose_catalog_unavailable');
    }
  }, [activeScope, binding, hasOptimisticBindings, inheritsPurposeDefaults, purposeScope, purposeCatalog.revision,
    purposeCatalog.value, connectedAccountDefaultsStatus, targetServerId]);
  const labelsByKey = useConnectedMetadataCatalog(connectedAccounts.length === 0 ? null
    : targetServerId ? binding?.scope ?? null : undefined, selectConnectedMetadataLabels);
  const { present } = useConnectedAccountIdentityPrivacy();
  const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
  const connectedServicesFeatureScope = React.useMemo<FeatureDecisionScopeParams | undefined>(() => {
    const trimmedTargetServerId = targetServerId?.trim() ?? '';
    if (!trimmedTargetServerId) return undefined;
    return { scopeKind: 'spawn', serverId: trimmedTargetServerId };
  }, [targetServerId]);
  const accountGroupsFeatureEnabled = useFeatureEnabled('connectedServices.accountGroups', connectedServicesFeatureScope);
  const coordinateTeamCredentialSelection = useTeamCredentialSelectionCoordinator(targetServerId);
  const teamCredentialContextRef = React.useRef({
    serverId: targetServerId,
    resources: params.teamCredentialResources ?? [],
    currentResourceKeys: params.teamCredentialResourceCurrentKeys,
  });
  teamCredentialContextRef.current = {
    serverId: targetServerId,
    resources: params.teamCredentialResources ?? [],
    currentResourceKeys: params.teamCredentialResourceCurrentKeys,
  };

  const supportedConnectedServiceIds = React.useMemo<ReadonlyArray<ConnectedAccountServiceKey>>(() => (
    resolveProjectedConnectedAccountServiceKeys(connectedAccounts)
  ), [connectedAccounts]);

  const connectedServiceProfileOptionsByServiceId = React.useMemo(() => (
    applyProjectedCredentialKindRestrictions({
      optionsByServiceId: buildQualifiedConnectedAccountProfileOptionsByServiceId({
        accounts: accountProfile?.connectedAccountsV4 ?? [],
        supportedServiceIds: supportedConnectedServiceIds,
        labelsByKey,
        presentIdentity: present,
      }),
      connectedAccounts,
    })
  ), [accountProfile?.connectedAccountsV4, connectedAccounts, labelsByKey, supportedConnectedServiceIds, present]);

  const connectedServiceAccountGroupOptionsByServiceId = React.useMemo(() => (
    buildQualifiedConnectedAccountGroupOptionsByServiceId({
      groups: accountProfile?.connectedAccountGroupsV4 ?? [],
      supportedServiceIds: supportedConnectedServiceIds,
      labelsByKey,
    })
  ), [accountProfile?.connectedAccountGroupsV4, labelsByKey, supportedConnectedServiceIds]);

  const connectedServicesBindingsByServiceId = React.useMemo(() => {
    const explicitBindings = parseConnectedServicesBindingsByServiceIdFromAgentOptionState({ agentOptionState });
    if (hasExplicitBindings) return explicitBindings;
    if (!defaultAuthAgentId || !defaultAuthConsumer || !purposeCatalog.value) return explicitBindings;

    return projectAgentConnectedAccountPurposeDefaultsToSessionBindings(
      resolveAgentConnectedAccountPurposeDefaults({
        settings: {
          connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
          connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
        },
        purposeBindings: purposeCatalog.value,
        agentId: defaultAuthAgentId,
        consumer: defaultAuthConsumer,
        declarations: connectedAccounts,
      }),
    )?.bindingsByServiceId ?? explicitBindings;
  }, [
    agentOptionState,
    connectedAccounts,
    defaultAuthAgentId,
    defaultAuthConsumer,
    hasExplicitBindings,
    purposeCatalog.value,
    settings.connectedServicesDefaultAuthByAgentIdV1,
    settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
  ]);

  const [optimisticBindings, setOptimisticBindings] = React.useState(() => ({
    contextKey: authoredContextKey, bindings: connectedServicesBindingsByServiceId,
  }));
  const optimisticBindingsByServiceId = hasOptimisticBindings && optimisticBindings.contextKey === authoredContextKey
    ? optimisticBindings.bindings : connectedServicesBindingsByServiceId;
  React.useEffect(() => {
    if (optimisticAuthored && (optimisticAuthored.contextKey !== authoredContextKey || optimisticAuthored.options !== agentOptionState)) {
      setOptimisticAuthored(null);
    }
  }, [agentOptionState, authoredContextKey, optimisticAuthored]);

  const connectedServicesBindingsPayload = React.useMemo(() => {
    if (connectedAccountDefaultsStatus !== 'ready') return null;
    return buildConnectedServicesBindingsPayload({
      supportedConnectedServiceIds,
      connectedServiceProfileOptionsByServiceId,
      connectedServiceAccountGroupOptionsByServiceId,
      connectedServicesBindingsByServiceId: optimisticBindingsByServiceId,
      defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
      accountGroupsFeatureEnabled,
      ...(params.emitWhenAllNative === undefined ? {} : { emitWhenAllNative: params.emitWhenAllNative }),
    });
  }, [
    accountGroupsFeatureEnabled,
    connectedAccountDefaultsStatus,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServiceProfileOptionsByServiceId,
    optimisticBindingsByServiceId,
    params.emitWhenAllNative,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
  ]);

  const connectedServicesModelProbeCacheIdentity = React.useMemo(() => {
    if (!connectedServicesBindingsPayload || !accountProfile) return null;
    const accountsV4 = accountProfile.connectedAccountsV4 ?? [];
    const groupsV4 = accountProfile.connectedAccountGroupsV4 ?? [];
    const legacyRevisions = accountProfile.connectedServiceCredentialRevisionsV1 ?? [];
    return JSON.stringify(Object.entries(connectedServicesBindingsPayload.bindingsByServiceId)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([serviceId, binding]) => {
        if (binding.source === 'team_resource') {
          return [
            serviceId,
            binding.source,
            binding.resourceId,
            teamResourceConnectedServiceSelectionKey(binding),
          ];
        }
        if (binding.source !== 'connected') return [serviceId, 'native'];
        const serviceAccounts = accountsV4.filter((account) => (
          buildQualifiedPluginContributionKey(account.ref.service) === serviceId
        ));
        const group = binding.selection === 'group'
          ? groupsV4.find((candidate) => (
            buildQualifiedPluginContributionKey(candidate.ref.service) === serviceId
            && candidate.ref.groupId === binding.groupId
          ))
          : undefined;
        const activeProfileId = binding.selection === 'profile'
          ? binding.profileId
          : group?.activeConnectedAccountId ?? null;
        const profile = activeProfileId
          ? serviceAccounts.find((candidate) => candidate.ref.accountId === activeProfileId)
          : undefined;
        // Credential revisions remain a released scalar-keyed projection;
        // resolve bundled services through the generated built-in mapping.
        // External plugin services contribute their V4 revision facts instead.
        const payloadIdentity = parseQualifiedPluginContributionKey(serviceId);
        const legacyServiceId = payloadIdentity
          ? getQualifiedConnectedServiceRegistryEntry(payloadIdentity)?.legacyServiceId ?? null
          : null;
        const revision = activeProfileId && legacyServiceId
          ? legacyRevisions.find((candidate) => (
            candidate.serviceId === legacyServiceId
            && candidate.profileId === activeProfileId
          ))?.credentialRevision ?? null
          : profile?.credentialRevision ?? null;
        return [
          serviceId,
          binding.selection,
          binding.selection === 'group' ? binding.groupId : binding.profileId,
          activeProfileId,
          profile?.providerIdentity?.accountId ?? null,
          revision,
          group?.generation ?? null,
        ];
      }));
  }, [accountProfile, connectedServicesBindingsPayload]);

  const setBindingForService = React.useCallback(async (serviceId: string, binding: ConnectedServicesServiceBinding) => {
    if (binding.source === 'team_resource') {
      const requestedTeamBinding = binding;
      const startedServerId = teamCredentialContextRef.current.serverId;
      const selectedResource = teamCredentialContextRef.current.resources.find((resource) => (
        resource.id === requestedTeamBinding.resourceId
        && resource.connectedServiceSelections.some((selection) => (
          selection.resourceId === requestedTeamBinding.resourceId
          && teamResourceConnectedServiceSelectionKey(selection) === teamResourceConnectedServiceSelectionKey(requestedTeamBinding)
        ))
      ));
      if (!selectedResource) return;
      const outcome = await coordinateTeamCredentialSelection({
        resource: selectedResource,
        deliveryMode: requestedTeamBinding.deliveryMode,
        selection: requestedTeamBinding,
        isCurrent: () => teamCredentialContextRef.current.serverId === startedServerId
          && (teamCredentialContextRef.current.currentResourceKeys === undefined
            || teamCredentialContextRef.current.currentResourceKeys.has(`${selectedResource.teamId}:${requestedTeamBinding.resourceId}`))
          && teamCredentialContextRef.current.resources.some((resource) => (
            resource.id === requestedTeamBinding.resourceId
            && resource.readiness.kind === 'available'
            && resource.connectedServiceSelections.some((selection) => (
              selection.resourceId === requestedTeamBinding.resourceId
              && teamResourceConnectedServiceSelectionKey(selection) === teamResourceConnectedServiceSelectionKey(requestedTeamBinding)
            ))
          )),
      });
      if (outcome.kind !== 'continue') return;
      binding = outcome.selection;
      if (params.applyTeamCredentialPolicy
          && !await params.applyTeamCredentialPolicy(selectedResource, () => (
            teamCredentialContextRef.current.serverId === startedServerId
          && (teamCredentialContextRef.current.currentResourceKeys === undefined
            || teamCredentialContextRef.current.currentResourceKeys.has(`${selectedResource.teamId}:${selectedResource.id}`))
          && teamCredentialContextRef.current.resources.some((resource) => (
            resource.id === selectedResource.id
            && resource.resourceRevision === selectedResource.resourceRevision
            && resource.readiness.kind === 'available'
          ))
        ))) return;
    }
    setOptimisticAuthored({ contextKey: authoredContextKey, options: agentOptionState });
    setOptimisticBindings((prev) => {
      const next = {
        ...(prev.contextKey === authoredContextKey && hasOptimisticBindings ? prev.bindings : connectedServicesBindingsByServiceId),
        [serviceId]: binding,
      };
      setAgentOptionStateForCurrentAgent(CONNECTED_SERVICES_BINDINGS_KEY, next);
      return { contextKey: authoredContextKey, bindings: next };
    });
  }, [agentOptionState, authoredContextKey, connectedServicesBindingsByServiceId, hasOptimisticBindings, coordinateTeamCredentialSelection, params.applyTeamCredentialPolicy, setAgentOptionStateForCurrentAgent]);

  /** Public applied-descriptor title; neutral fallback for an unknown service. */
  const resolveServiceTitle = React.useCallback((serviceId: string) => {
    const service = parseQualifiedPluginContributionKey(serviceId);
    return service
      ? resolveQualifiedConnectedServiceRegistryDisplayName(connectedServicesRegistry, service, t)
      : serviceId;
  }, [connectedServicesRegistry]);

  const authLabel = React.useMemo(() => resolveConnectedServicesAuthLabel({
    supportedServiceIds: supportedConnectedServiceIds,
    bindingsByServiceId: optimisticBindingsByServiceId,
    profileOptionsByServiceId: connectedServiceProfileOptionsByServiceId,
    accountGroupOptionsByServiceId: connectedServiceAccountGroupOptionsByServiceId,
    accountGroupsEnabled: accountGroupsFeatureEnabled,
    defaultProfileIdByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    resolveServiceTitle,
    nativeLabel: t('connectedServices.authChip.nativeLabel'),
    formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
  }), [
    accountGroupsFeatureEnabled,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServiceProfileOptionsByServiceId,
    optimisticBindingsByServiceId,
    resolveServiceTitle,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
  ]);

  // Hoisted out of the render callback below: the selection content INVOKES this
  // during its list build and bakes the result into every option, so it stays a
  // dependency of that build. Recreated inline it changed identity on every
  // `renderContent(...)` pass and rebuilt the whole step tree; as a memoised
  // callback it changes only when the availability data actually does.
  const resolveOptionAvailability = React.useCallback(({ serviceId, optionId }: Readonly<{
    serviceId: string;
    optionId: string;
  }>) => {
    const state = authLabel.serviceStatesById[serviceId];
    if (
      state?.warningCode
      && optionId === `connected-service:${encodeURIComponent(serviceId)}:native`
    ) {
      return {
        subtitle: resolveDefaultAuthWarningLabel(state.warningCode),
      };
    }
    return {};
  }, [authLabel]);

  const connectedServicesAuthPopoverContent = React.useCallback(({ maxHeight }: AgentInputContentPopoverRenderArgs) => (
    <NewSessionConnectedServicesSelectionContent
      supportedServiceIds={supportedConnectedServiceIds}
      profileOptionsByServiceId={connectedServiceProfileOptionsByServiceId}
      groupOptionsByServiceId={connectedServiceAccountGroupOptionsByServiceId}
      bindingsByServiceId={optimisticBindingsByServiceId}
      bindingsKnown={connectedAccountDefaultsStatus === 'ready'}
      teamCredentialResources={params.teamCredentialResources}
      teamCredentialResourceCurrentKeys={params.teamCredentialResourceCurrentKeys}
      teamNameById={params.teamNameById}
      onRecoverTeamCredentialResource={(resource) => {
        if (!targetServerId) return;
        router.push(teamCredentialDetailPath({ serverId: targetServerId, teamId: resource.teamId }, resource.id));
      }}
      setBindingForService={setBindingForService}
      defaultProfileIdByServiceId={settings.connectedServicesDefaultProfileByServiceId}
      resolveOptionAvailability={resolveOptionAvailability}
      onOpenSettings={(serviceId) => {
        router.push(resolveConnectedServiceProfileActionRoute(
          { serviceId },
          connectedServicesRegistry.entries,
        ));
      }}
      onReconnectProfile={(serviceId, profileId) => {
        router.push(resolveConnectedServiceProfileActionRoute(
          { serviceId, profileId },
          connectedServicesRegistry.entries,
        ));
      }}
      maxHeight={maxHeight}
    />
  ), [
    connectedServicesRegistry.entries,
    connectedServiceProfileOptionsByServiceId,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedAccountDefaultsStatus,
    optimisticBindingsByServiceId,
    resolveOptionAvailability,
    router,
    setBindingForService,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
    params.teamCredentialResources,
    params.teamCredentialResourceCurrentKeys,
    params.teamNameById,
    targetServerId,
  ]);

  const nativeAuthSource = connectedAccountDefaultsStatus !== 'ready' ? 'unknown' as const
    : authLabel.connectedCount === 0 ? 'native' as const
    : authLabel.connectedCount === supportedConnectedServiceIds.length ? 'connected' as const : 'mixed' as const;
  const routePresentation = React.useMemo(() => resolveSessionRoutePresentation({
    phase: 'draft', selection: params.modelSelection ?? null, sources: params.providerSources,
    native: { label: authLabel.label, connectedCount: authLabel.connectedCount, authSource: nativeAuthSource },
    teamSources: params.modelRouteTeamSources,
  }), [params.modelSelection, params.providerSources, params.modelRouteTeamSources, authLabel, nativeAuthSource]);

  const requesterSignInPurposes = React.useMemo(() => {
    if (connectedAccountDefaultsStatus !== 'ready') return [];
    const targetRegistry = { entries: projectConnectedServiceRegistryEntries({ scopeKey: targetServerId ?? '', status: 'ready',
      descriptors: Object.values(params.providerProjection?.familiesById.connectedAccounts?.entriesById ?? {}),
      conflicts: [], errorReason: null }) };
    const resolveTitle = (service: PluginContributionIdentityV1) => resolveQualifiedConnectedServiceRegistryDisplayName(targetRegistry, service, t);
    const route = routePresentation.applied;
    if (route.kind === 'team') return route.deliveryMode === 'direct' && route.sourceLabel ? [route.sourceLabel] : [];
    const connection = route.kind === 'provider'
      ? params.providerSettings?.connections.find(connection => connection.id === route.connectionId) : null;
    const source = connection ? readProviderConnectionDisclosureSource({ connection, projection: params.providerProjection,
      machineId: params.sourceMachineId ?? '', resolveServiceTitle: resolveTitle }) : null;
    const providerPurposes = source && route.kind === 'provider' ? projectProviderRouteSignInPurposes({
      route: { ...route, sourceLabel: route.sourceLabel ?? providerConnectionSourceLabel(source.source) },
      machineId: params.sourceMachineId ?? '', secretBindings: params.providerSettings?.secretBindingsByConnectionId[route.connectionId],
      credentialSlotId: source.credentialSlotId, managedSignInPurposes: source.managedSignInPurposes,
    }) : [];
    const selectedSource = route.kind === 'provider'
      ? params.providerSources?.find(source => source.connectionId === route.connectionId) : null;
    const nativePurposes = route.kind === 'provider' && !selectedSource ? [] : projectSessionCredentialSignInPurposes({ declarations: connectedAccounts,
      bindings: connectedServicesBindingsPayload, resolveServiceTitle: resolveTitle,
      formatNativeTitle: service => t('machineRequester.nativeSignInPurpose', { service }),
      // A Provider replaces native authentication only through its Agent adapter's actual suppression projection.
      suppressedServiceIds: selectedSource?.suppressedConnectedServiceIds,
    });
    return [...new Set([...providerPurposes, ...nativePurposes])];
  }, [connectedAccountDefaultsStatus, connectedAccounts, connectedServicesBindingsPayload,
    params.providerProjection, params.providerSettings, params.providerSources, params.sourceMachineId, routePresentation, targetServerId]);

  const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (supportedConnectedServiceIds.length === 0) return null;
        // "Runs through …" names the route the draft would start with; while account defaults load,
        // the incumbent loading/unavailable label stays rather than a guessed route.
        const routeChip = presentSessionRouteChip(routePresentation, { label: authLabel.label, authSource: nativeAuthSource });
        return createConnectedServicesAuthActionChip({
            label: routeChip?.label ?? (connectedAccountDefaultsStatus !== 'ready' && authLabel.connectedCount === 0
                ? t(connectedAccountDefaultsStatus === 'loading' ? 'common.loading' : 'common.unavailable')
                : authLabel.label),
            connectedCount: authLabel.connectedCount,
            authSource: nativeAuthSource,
            popoverContent: connectedServicesAuthPopoverContent,
            maxHeightCap: 560,
            maxWidthCap: 560,
        });
    }, [authLabel, connectedAccountDefaultsStatus, connectedServicesAuthPopoverContent, nativeAuthSource, routePresentation, supportedConnectedServiceIds]);

  const selectedCredentialMachineAgent = React.useMemo(() => projectMachineAgentForCredential(params.machineAgent, {
    credentialBindings: connectedServicesBindingsPayload,
    groupOptionsByServiceId: connectedServiceAccountGroupOptionsByServiceId,
    teamCredentialResources: params.teamCredentialResources,
  }), [params.machineAgent, connectedServicesBindingsPayload, connectedServiceAccountGroupOptionsByServiceId, params.teamCredentialResources]);
  const connectedServicesRecoveryAction = React.useMemo<AttentionBannerAction | null>(() => {
    if (connectedAccountDefaultsStatus !== 'ready' || selectedCredentialMachineAgent?.state !== 'needsSignIn'
        || selectedCredentialMachineAgent.signIn.native?.status !== 'signedOut'
        || Object.values(connectedServicesBindingsPayload?.bindingsByServiceId ?? {}).some((binding) => binding.source !== 'native')) return null;
    for (const serviceId of supportedConnectedServiceIds) {
      const service = params.machineAgent?.signIn.connectedServices.find((service) => service.serviceId === serviceId && service.healthy);
      const option = connectedServiceProfileOptionsByServiceId[serviceId]?.find((option) => service?.profiles?.some((profile) => profile.profileId === option.profileId && profile.healthy));
      if (option) return {
        label: option.label ?? option.providerEmail ?? resolveServiceTitle(serviceId),
        testID: 'new-session-agent-blocker.connected',
        onPress: () => { void setBindingForService(serviceId, { source: 'connected', selection: 'profile', profileId: option.profileId }); },
      };
    }
    return null;
  }, [connectedAccountDefaultsStatus, selectedCredentialMachineAgent, connectedServicesBindingsPayload, supportedConnectedServiceIds,
    params.machineAgent, connectedServiceProfileOptionsByServiceId, resolveServiceTitle, setBindingForService]);

  return { routePresentation, requesterSignInPurposes, connectedAccountDefaultsStatus, requireConnectedAccountDefaultsReady, connectedServicesBindingsPayload, connectedServicesModelProbeCacheIdentity, connectedServicesAuthChip,
    selectedCredentialMachineAgent, connectedServicesRecoveryAction };
}
