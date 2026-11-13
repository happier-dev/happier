import { useDirectDeliveryDisclosure } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';
import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import React from 'react';
import { Modal } from '@/modal';
import { presentSessionSpawnNewConnectedAccountFailure } from '@/sync/ops/actions/sessionSpawnFailurePresentation';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { presentNativeRouteSourceLabel, presentSessionRouteChip, resolveSessionRoutePresentation, readProviderRouteConnectionId, projectProviderRouteSignInPurposes, readProviderConnectionDisclosureSource, providerConnectionSourceLabel, type RouteSelection, type ProviderRouteSource, type SessionRoutePresentationInput } from '@/providers/session/resolveSessionRoutePresentation';

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
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { ConnectedAccountCatalogOperationError } from '@/sync/api/account/apiConnectedAccountCatalog';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { AgentCore } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol/account/settings/connected-services';
import { resolveAgentConnectedServicesDefaultBindings } from '@/sync/domains/connectedServices/resolveAgentConnectedServicesDefaultBindings';
import type { ConnectedAccountServiceKey, ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PluginProjectedAgentConnectedAccountPurposeV2, PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ProviderSettingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import type { ManagedSessionDefaultsContext, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { useNewSessionConnectedServiceOptions } from './useNewSessionConnectedServiceOptions';
import type { SessionRouteSources } from '@/components/sessions/new/components/useSessionRouteSourceSections';
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
  hasConnectedServicesBindingsInAgentOptionState,
  teamResourceConnectedServiceSelectionKey,
  type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { getQualifiedConnectedServiceRegistryEntry, projectConnectedServiceRegistryEntries, resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
  resolveProjectedConnectedAccountServiceKeys,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import {
  buildConnectedServicesBindingsPayload,
  projectSessionCredentialSignInPurposes,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { projectMachineAgentForCredential } from '@/agents/machineAgents/machineAgentModel';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import type { SessionInstrumentStripLineAction } from '@/components/sessions/agentInput/instrumentStrip';
import { resolveSelectedProviderRoute } from '@/providers/session/resolveSelectedProviderRoute';
import { providerDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { formatConnectedAccountNameInline, presentConnectedAccountName } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';

export type NewSessionConnectedServicesResult = Readonly<{
  routePresentation: ReturnType<typeof resolveSessionRoutePresentation>;
  /** The account or pool the selected Agent's own models would run through; null for its own sign-in. */
  nativeSourceLabel: string | null;
  requesterSignInPurposes: readonly string[];
  connectedAccountDefaultsStatus: 'loading' | 'ready' | 'unavailable';
  requireConnectedAccountDefaultsReady: () => void;
  presentConnectedAccountPoolFailure: (
    failure: Exclude<SessionSpawnNewResultV1, { type: 'success' }>,
    recoverRetiredSelection?: (serviceId: string, binding: ConnectedServicesServiceBinding) => boolean,
  ) => boolean;
  connectedServicesBindingsPayload: ConnectedServiceBindingsV2 | null;
  connectedServicesModelProbeCacheIdentity: string | null;
  connectedServicesAuthChip: AgentInputExtraActionChip | null;
  selectedCredentialMachineAgent: MachineAgent | null;
  connectedServicesRecoveryAction: SessionInstrumentStripLineAction | null;
}>;

function resolveDefaultAuthWarningLabel(warningCode: ConnectedServicesAuthWarningCode | undefined): string | undefined {
  const key = resolveConnectedServicesAuthWarningTranslationKey(warningCode);
  return key ? t(key) : undefined;
}


export function useNewSessionConnectedServices(params: Readonly<{
  placementId?: string;
  placementPending?: boolean;
  modelSelection?: RouteSelection;
  providerSources?: readonly ProviderRouteSource[];
  /** The selected Agent's Gateways and Providers for the "Runs through" popover; omitted, it names none. */
  routeSources?: SessionRouteSources;
  nativeAgentTargetKey?: string;
  managedSessionDefaults?: ManagedSessionDefaultsContext;
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
  teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
  teamNameById?: Readonly<Record<string, string>>;
  router: { push: (path: any) => void };
  setAgentOptionStateForCurrentAgent: (key: string, value: unknown) => void;
  applyTeamCredentialPolicy?: (
    resource: TeamCredentialResourceCatalogEntryV1,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
}>): NewSessionConnectedServicesResult {
  const { agentCore, connectedAccounts, agentOptionState, settings, targetServerId, router, setAgentOptionStateForCurrentAgent } = params;
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
  const hasControlledBindings = hasConnectedServicesBindingsInAgentOptionState(agentOptionState);
  const hasOptimisticBindings = optimisticAuthored?.contextKey === authoredContextKey && optimisticAuthored.options === agentOptionState;
  const hasExplicitBindings = hasControlledBindings || hasOptimisticBindings;
  const [optimisticBindings, setOptimisticBindings] = React.useState<Readonly<{
    contextKey: string; bindings: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  }>>(() => ({ contextKey: authoredContextKey, bindings: {} }));
  const explicitBindings = React.useMemo(() => (
    hasOptimisticBindings && optimisticBindings.contextKey === authoredContextKey
      ? optimisticBindings.bindings
      : hasExplicitBindings ? parseConnectedServicesBindingsByServiceIdFromAgentOptionState({ agentOptionState }) : undefined
  ), [agentOptionState, authoredContextKey, hasExplicitBindings, hasOptimisticBindings, optimisticBindings]);
  const supportedConnectedServiceIds = React.useMemo<ReadonlyArray<ConnectedAccountServiceKey>>(() => (
    resolveProjectedConnectedAccountServiceKeys(connectedAccounts)
  ), [connectedAccounts]);
  const selectedProviderConnectionId = readProviderRouteConnectionId(params.modelSelection ?? null);
  const selectedProviderSource = React.useMemo(() => selectedProviderConnectionId
    ? params.providerSources?.find(source => source.connectionId === selectedProviderConnectionId) ?? null : null,
  [params.providerSources, selectedProviderConnectionId]);
  const selectedProviderRoute = React.useMemo(() => resolveSelectedProviderRoute({
    selection: params.modelSelection ?? null,
    agentTargetKey: params.nativeAgentTargetKey,
    declarationContext: providerDeclarationContext(params.sourceMachineId, params.providerProjection),
    providerSources: params.providerSources,
    teamCredentialResources: params.teamCredentialResources,
    teamCredentialResourceStatusByKey: params.teamCredentialResourceStatusByKey,
    acceptedConnectedServiceIds: supportedConnectedServiceIds,
  }), [params.modelSelection, params.nativeAgentTargetKey, params.teamCredentialResources,
    params.teamCredentialResourceStatusByKey, params.providerProjection, params.sourceMachineId,
    params.providerSources, supportedConnectedServiceIds]);
  const inheritsPurposeDefaults = React.useMemo(() => {
    if (hasExplicitBindings) return false;
    const suppressed = new Set((selectedProviderRoute?.ready ? selectedProviderRoute.suppressedConnectedServiceIds : [])
      .map(resolveQualifiedConnectedAccountServiceKey));
    return supportedConnectedServiceIds.some(serviceId => !suppressed.has(serviceId));
  }, [hasExplicitBindings, selectedProviderRoute, supportedConnectedServiceIds]);
  const needsNativeSignInRecovery = supportedConnectedServiceIds.length > 0
    && params.machineAgent?.signIn.native?.status === 'signedOut'
    && !selectedProviderRoute?.ready
    && Object.values(explicitBindings ?? {}).every(binding => !binding || binding.source === 'native');
  const needsPurposeCatalog = inheritsPurposeDefaults || needsNativeSignInRecovery;
  const purposeCatalog = useConnectedAccountCatalog('purposes', needsPurposeCatalog ? purposeScope : null,
    { sourceMachineId: params.sourceMachineId, enabled: needsPurposeCatalog });
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
      || !binding || !readServerAccountScopeOwnerLifetime(binding).isCurrent()
      || (currentFocusedScope && !areServerAccountScopesEqual(currentFocusedScope, purposeScope))
      || current.status !== 'ready' || current.stale || !current.value
      || current.revision !== purposeCatalog.revision || current.value !== purposeCatalog.value) {
      throw new ConnectedAccountCatalogOperationError('connected_account_purpose_catalog_unavailable');
    }
  }, [activeScope, binding, hasOptimisticBindings, inheritsPurposeDefaults, purposeScope, purposeCatalog.revision,
    purposeCatalog.value, connectedAccountDefaultsStatus, targetServerId]);
  const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
  /** Public applied-descriptor title; neutral fallback for an unknown service. */
  const resolveServiceTitle = React.useCallback((serviceId: string) => {
    const service = parseQualifiedPluginContributionKey(serviceId);
    return service
      ? resolveQualifiedConnectedServiceRegistryDisplayName(connectedServicesRegistry, service, t)
      : serviceId;
  }, [connectedServicesRegistry]);

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
    resourceStatusByKey: params.teamCredentialResourceStatusByKey,
  });
  teamCredentialContextRef.current = {
    serverId: targetServerId,
    resources: params.teamCredentialResources ?? [],
    resourceStatusByKey: params.teamCredentialResourceStatusByKey,
  };

  const connectedServicesBindingsByServiceId = React.useMemo(() => {
    if (explicitBindings && !params.managedSessionDefaults) return explicitBindings;
    if (!defaultAuthAgentId || !defaultAuthConsumer) return explicitBindings ?? {};
    if (!purposeCatalog.value && !params.managedSessionDefaults) return explicitBindings ?? {};

    return resolveAgentConnectedServicesDefaultBindings({
      settings: {
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
      },
      purposeBindings: purposeCatalog.value ?? { v: 1, bindings: [] },
      agentId: defaultAuthAgentId,
      consumer: defaultAuthConsumer,
      declarations: connectedAccounts,
      managedSessionDefaults: params.managedSessionDefaults,
      agentTargetKey: params.nativeAgentTargetKey,
      explicitBindings,
    }).bindingsByServiceId;
  }, [
    connectedAccounts,
    defaultAuthAgentId,
    defaultAuthConsumer,
    explicitBindings,
    params.managedSessionDefaults,
    params.nativeAgentTargetKey,
    purposeCatalog.value,
    settings.connectedServicesDefaultAuthByAgentIdV1,
    settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
  ]);

  const recoveryDefaultBindings = React.useMemo(() => {
    if (!needsNativeSignInRecovery || !defaultAuthAgentId || !defaultAuthConsumer
      || purposeCatalog.status !== 'ready' || purposeCatalog.stale || !purposeCatalog.value) return null;
    return resolveAgentConnectedServicesDefaultBindings({
      settings: {
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
      },
      purposeBindings: purposeCatalog.value,
      agentId: defaultAuthAgentId, consumer: defaultAuthConsumer, declarations: connectedAccounts,
      managedSessionDefaults: params.managedSessionDefaults, agentTargetKey: params.nativeAgentTargetKey,
    }).bindingsByServiceId;
  }, [needsNativeSignInRecovery, defaultAuthAgentId, defaultAuthConsumer, purposeCatalog.status, purposeCatalog.stale,
    purposeCatalog.value, settings.connectedServicesDefaultAuthByAgentIdV1, settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
    connectedAccounts, params.managedSessionDefaults, params.nativeAgentTargetKey]);
  const connectedServiceOptionsInput = React.useMemo(() => ({
    connectedAccounts,
    supportedServiceIds: supportedConnectedServiceIds,
    scope: connectedAccounts.length === 0 ? null : targetServerId ? binding?.scope ?? null : undefined,
    resolveServiceTitle,
  }), [connectedAccounts, supportedConnectedServiceIds, targetServerId, binding?.scope, resolveServiceTitle]);
  const selectedBindings = React.useMemo(() => recoveryDefaultBindings
    ? [connectedServicesBindingsByServiceId, recoveryDefaultBindings] : [connectedServicesBindingsByServiceId],
  [connectedServicesBindingsByServiceId, recoveryDefaultBindings]);
  const { accountProfile, profileOptionsByServiceId: connectedServiceProfileOptionsByServiceId,
    groupOptionsByServiceId: connectedServiceAccountGroupOptionsByServiceId } = useNewSessionConnectedServiceOptions(
    connectedServiceOptionsInput, selectedBindings,
  );

  // One model choice can author native auth for several services before React commits a render.
  const bindingsForSelectionRef = React.useRef(explicitBindings ?? {});
  bindingsForSelectionRef.current = explicitBindings ?? {};
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
      connectedServicesBindingsByServiceId,
      defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
      accountGroupsFeatureEnabled,
      ...(params.emitWhenAllNative === undefined ? {} : { emitWhenAllNative: params.emitWhenAllNative }),
    });
  }, [
    accountGroupsFeatureEnabled,
    connectedAccountDefaultsStatus,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServiceProfileOptionsByServiceId,
    connectedServicesBindingsByServiceId,
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
          && (teamCredentialContextRef.current.resourceStatusByKey === undefined
            || (teamCredentialContextRef.current.resourceStatusByKey.get(`${selectedResource.teamId}:${requestedTeamBinding.resourceId}`)?.kind === 'current'))
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
          && (teamCredentialContextRef.current.resourceStatusByKey === undefined
            || (teamCredentialContextRef.current.resourceStatusByKey.get(`${selectedResource.teamId}:${selectedResource.id}`)?.kind === 'current'))
          && teamCredentialContextRef.current.resources.some((resource) => (
            resource.id === selectedResource.id
            && resource.resourceRevision === selectedResource.resourceRevision
            && resource.readiness.kind === 'available'
          ))
        ))) return;
    }
    const next = { ...bindingsForSelectionRef.current, [serviceId]: binding };
    bindingsForSelectionRef.current = next;
    setOptimisticAuthored({ contextKey: authoredContextKey, options: agentOptionState });
    setAgentOptionStateForCurrentAgent(CONNECTED_SERVICES_BINDINGS_KEY, next);
    setOptimisticBindings({ contextKey: authoredContextKey, bindings: next });
  }, [agentOptionState, authoredContextKey, coordinateTeamCredentialSelection, params.applyTeamCredentialPolicy, setAgentOptionStateForCurrentAgent]);

  const presentConnectedAccountPoolFailure = React.useCallback((
    failure: Exclude<SessionSpawnNewResultV1, { type: 'success' }>,
    recoverRetiredSelection?: (serviceId: string, binding: ConnectedServicesServiceBinding) => boolean,
  ) => (
    presentSessionSpawnNewConnectedAccountFailure(failure, resolveServiceTitle, action => {
      const service = parseQualifiedPluginContributionKey(action.serviceId);
      if (!service) return;
      fireAndForget((async () => {
        const { presentConnectSheet } = await import('@/components/settings/connectedServices/setup/ConnectedServiceSetupModal');
        const result = await presentConnectSheet({ scope: purposeScope, service, intent: 'link',
          ...(action.kind === 'reconnect' ? { intent: 'reconnect' as const,
            account: { service, accountId: action.profileId } } : {}),
        });
        if (result.kind !== 'dismissed') {
          const binding = { source: 'connected' as const, selection: 'profile' as const, profileId: result.account.accountId };
          if (!recoverRetiredSelection?.(action.serviceId, binding)) {
            await setBindingForService(action.serviceId, binding);
          }
        }
      })(), { tag: 'newSession.connectedAccountRecovery' });
    }, Modal.alert, (serviceId, profileId) => connectedServiceProfileOptionsByServiceId[serviceId]
      ?.find(option => option.profileId === profileId)?.label ?? null)
  ), [connectedServiceProfileOptionsByServiceId, purposeScope, resolveServiceTitle, setBindingForService]);

  const authLabel = React.useMemo(() => resolveConnectedServicesAuthLabel({
    supportedServiceIds: supportedConnectedServiceIds,
    bindingsByServiceId: connectedServicesBindingsByServiceId,
    profileOptionsByServiceId: connectedServiceProfileOptionsByServiceId,
    accountGroupOptionsByServiceId: connectedServiceAccountGroupOptionsByServiceId,
    accountGroupsEnabled: accountGroupsFeatureEnabled,
    defaultProfileIdByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    resolveServiceTitle,
    nativeLabel: t('connectedServices.authChip.nativeLabel'),
    formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
    teamCredentialResources: params.teamCredentialResources,
    teamNameById: params.teamNameById,
  }), [
    accountGroupsFeatureEnabled,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServiceProfileOptionsByServiceId,
    connectedServicesBindingsByServiceId,
    resolveServiceTitle,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
    params.teamCredentialResources,
    params.teamNameById,
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

  const nativeAuthSource = connectedAccountDefaultsStatus !== 'ready' ? 'unknown' as const
    : authLabel.connectedCount === 0 ? 'native' as const
    : authLabel.connectedCount === supportedConnectedServiceIds.length ? 'connected' as const : 'mixed' as const;
  const routePresentation = React.useMemo(() => resolveSessionRoutePresentation({
    phase: 'draft', selection: params.modelSelection ?? null, sources: params.providerSources,
    native: { label: authLabel.label, connectedCount: authLabel.connectedCount, authSource: nativeAuthSource },
    teamSources: params.modelRouteTeamSources,
  }), [params.modelSelection, params.providerSources, params.modelRouteTeamSources, authLabel, nativeAuthSource]);

  // Direct delivery says where agents run on the selected Machine now (MI-2), from facts its record holds.
  const directDelivery = useDirectDeliveryDisclosure(params.sourceMachineId, targetServerId);
  const connectedServicesAuthPopoverContent = React.useCallback(({ maxHeight }: AgentInputContentPopoverRenderArgs) => (
    <NewSessionConnectedServicesSelectionContent
      inventoryInput={connectedServiceOptionsInput}
      supportedServiceIds={supportedConnectedServiceIds}
      profileOptionsByServiceId={connectedServiceProfileOptionsByServiceId}
      groupOptionsByServiceId={connectedServiceAccountGroupOptionsByServiceId}
      bindingsByServiceId={connectedServicesBindingsByServiceId}
      bindingsKnown={connectedAccountDefaultsStatus === 'ready'}
      declarationContext={providerDeclarationContext(params.sourceMachineId, params.providerProjection)}
      teamCredentialResources={params.teamCredentialResources}
      teamCredentialResourceStatusByKey={params.teamCredentialResourceStatusByKey}
      teamNameById={params.teamNameById}
      directDelivery={directDelivery}
      onRecoverTeamCredentialResource={(resource) => {
        if (!targetServerId) return;
        router.push(teamCredentialDetailPath({ serverId: targetServerId, teamId: resource.teamId }, resource.id));
      }}
      setBindingForService={setBindingForService}
      routeSources={params.routeSources}
      nativeAgentTargetKey={params.nativeAgentTargetKey}
      appliedRoute={routePresentation.applied}
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
    connectedServiceOptionsInput,
    connectedServicesRegistry.entries,
    connectedServiceProfileOptionsByServiceId,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedAccountDefaultsStatus,
    connectedServicesBindingsByServiceId,
    resolveOptionAvailability,
    router,
    setBindingForService,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
    params.teamCredentialResources,
    params.teamCredentialResourceStatusByKey,
    params.teamNameById,
    directDelivery,
    params.routeSources,
    params.nativeAgentTargetKey,
    params.sourceMachineId,
    params.providerProjection,
    routePresentation.applied,
    targetServerId,
  ]);

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
      machineId: params.sourceMachineId ?? '', secretBindings: connection ? params.providerSettings?.secretBindingsByConnectionId[connection.id] : undefined,
      credentialSlotId: source.credentialSlotId, managedSignInPurposes: source.managedSignInPurposes,
    }) : [];
    const nativePurposes = route.kind === 'provider' && !selectedProviderSource ? [] : projectSessionCredentialSignInPurposes({ declarations: connectedAccounts,
      bindings: connectedServicesBindingsPayload, resolveServiceTitle: resolveTitle,
      formatNativeTitle: service => t('machineRequester.nativeSignInPurpose', { service }),
      // A Provider replaces native authentication only through its Agent adapter's actual suppression projection.
      suppressedServiceIds: selectedProviderSource?.suppressedConnectedServiceIds,
    });
    return [...new Set([...providerPurposes, ...nativePurposes])];
  }, [connectedAccountDefaultsStatus, connectedAccounts, connectedServicesBindingsPayload,
    params.providerProjection, params.providerSettings, selectedProviderSource, params.sourceMachineId, routePresentation, targetServerId]);

  const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (supportedConnectedServiceIds.length === 0) return null;
        // "Runs through …" names the route the draft would start with; while account defaults load,
        // the incumbent loading/unavailable label stays rather than a guessed route.
        const routeChip = presentSessionRouteChip(routePresentation, { label: authLabel.label, authSource: nativeAuthSource });
        return createConnectedServicesAuthActionChip({
            placementId: params.placementId,
            pending: params.placementPending === true || authLabel.warningCodes.length > 0 || connectedAccountDefaultsStatus === 'unavailable',
            label: routeChip?.label ?? (connectedAccountDefaultsStatus !== 'ready' && authLabel.connectedCount === 0
                ? t(connectedAccountDefaultsStatus === 'loading' ? 'common.loading' : 'common.unavailable')
                : authLabel.label),
            connectedCount: authLabel.connectedCount,
            authSource: nativeAuthSource,
            popoverContent: connectedServicesAuthPopoverContent,
            agentId: defaultAuthAgentId,
        });
    }, [authLabel, connectedAccountDefaultsStatus, connectedServicesAuthPopoverContent, defaultAuthAgentId, nativeAuthSource, routePresentation, supportedConnectedServiceIds, params.placementId, params.placementPending]);

  const selectedCredentialMachineAgent = React.useMemo(() => projectMachineAgentForCredential(params.machineAgent, {
    credentialBindings: connectedServicesBindingsPayload,
    providerRoute: selectedProviderRoute,
    groupOptionsByServiceId: connectedServiceAccountGroupOptionsByServiceId,
    teamCredentialResources: params.teamCredentialResources,
  }), [params.machineAgent, connectedServicesBindingsPayload, selectedProviderRoute, connectedServiceAccountGroupOptionsByServiceId, params.teamCredentialResources]);
  const connectedServicesRecoveryAction = React.useMemo<SessionInstrumentStripLineAction | null>(() => {
    const failure = selectedCredentialMachineAgent?.signIn.connectedAccountFailure;
    if (connectedAccountDefaultsStatus === 'ready' && failure) return {
      label: t('connectedServices.detail.actions.reconnect'),
      testID: 'new-session-agent-blocker.reconnect',
      onPress: () => router.push(resolveConnectedServiceProfileActionRoute(failure, connectedServicesRegistry.entries)),
    };
    if (connectedAccountDefaultsStatus !== 'ready' || selectedCredentialMachineAgent?.state !== 'needsSignIn'
        || selectedCredentialMachineAgent.signIn.native?.status !== 'signedOut'
        || !recoveryDefaultBindings
        || Object.values(connectedServicesBindingsPayload?.bindingsByServiceId ?? {}).some((binding) => binding.source !== 'native')) return null;
    for (const serviceId of supportedConnectedServiceIds) {
      const service = params.machineAgent?.signIn.connectedServices.find((service) => service.serviceId === serviceId && service.healthy);
      const configured = recoveryDefaultBindings[serviceId];
      if (configured?.source !== 'connected') continue;
      const group = configured.selection === 'group'
        ? connectedServiceAccountGroupOptionsByServiceId[serviceId]?.find(group => group.groupId === configured.groupId) : null;
      if (configured.selection === 'group'
        && (!accountGroupsFeatureEnabled || !group?.activeProfileId)) continue;
      const selectedProfileId = configured.selection === 'group' ? group?.activeProfileId : configured.profileId;
      const option = connectedServiceProfileOptionsByServiceId[serviceId]?.find((option) => (
        option.profileId === selectedProfileId
        && service?.profiles?.some((profile) => profile.profileId === option.profileId && profile.healthy)
      ));
      if (option) return {
        // The line says this route needs sign-in; the account is one tap away, so the action says so.
        label: t('machineAgents.useConnectedAccount', { account: group?.label
          ?? formatConnectedAccountNameInline(presentConnectedAccountName({ serviceTitle: resolveServiceTitle(serviceId),
            userLabel: option.label, email: option.providerEmail })) }),
        testID: 'new-session-agent-blocker.connected',
        truncates: true,
        onPress: () => { void setBindingForService(serviceId, group
          ? { source: 'connected', selection: 'group', groupId: group.groupId }
          : { source: 'connected', selection: 'profile', profileId: option.profileId }); },
      };
    }
    return null;
  }, [connectedAccountDefaultsStatus, selectedCredentialMachineAgent, connectedServicesBindingsPayload, supportedConnectedServiceIds,
    params.machineAgent, connectedServiceProfileOptionsByServiceId, connectedServiceAccountGroupOptionsByServiceId,
    accountGroupsFeatureEnabled, recoveryDefaultBindings, resolveServiceTitle, setBindingForService, router, connectedServicesRegistry.entries]);

  const nativeSourceLabel = supportedConnectedServiceIds.length > 0
    ? presentNativeRouteSourceLabel({ label: authLabel.label, authSource: nativeAuthSource }) : null;

  return { routePresentation, nativeSourceLabel, requesterSignInPurposes, connectedAccountDefaultsStatus, requireConnectedAccountDefaultsReady, presentConnectedAccountPoolFailure, connectedServicesBindingsPayload, connectedServicesModelProbeCacheIdentity, connectedServicesAuthChip,
    selectedCredentialMachineAgent, connectedServicesRecoveryAction };
}
