import React from 'react';
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
import type { AgentCore } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings, resolveAgentConnectedAccountPurposeDefaults, type ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol/account/settings/connected-services';
import type { ConnectedAccountServiceKey, ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PluginProjectedAgentConnectedAccountPurposeV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
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
import { getQualifiedConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
  applyProjectedCredentialKindRestrictions,
  buildQualifiedConnectedAccountGroupOptionsByServiceId,
  buildQualifiedConnectedAccountProfileOptionsByServiceId,
  resolveProjectedConnectedAccountServiceKeys,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import {
  buildConnectedServicesBindingsPayload,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

export type NewSessionConnectedServicesResult = Readonly<{
  connectedServicesBindingsPayload: ConnectedServiceBindingsV2 | null;
  connectedServicesModelProbeCacheIdentity: string | null;
  connectedServicesAuthChip: AgentInputExtraActionChip | null;
}>;

function resolveDefaultAuthWarningLabel(warningCode: ConnectedServicesAuthWarningCode | undefined): string | undefined {
  const key = resolveConnectedServicesAuthWarningTranslationKey(warningCode);
  return key ? t(key) : undefined;
}

function areServiceBindingsEqual(
  left: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>,
  right: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const leftBinding = left[key];
    const rightBinding = right[key];
    if (leftBinding?.source !== rightBinding?.source) return false;
    if (leftBinding?.source === 'team_resource' || rightBinding?.source === 'team_resource') {
      if (leftBinding?.source !== 'team_resource' || rightBinding?.source !== 'team_resource') return false;
      if (leftBinding.resourceId !== rightBinding.resourceId) return false;
      if (teamResourceConnectedServiceSelectionKey(leftBinding) !== teamResourceConnectedServiceSelectionKey(rightBinding)) return false;
      continue;
    }
    if (leftBinding?.source !== 'connected' || rightBinding?.source !== 'connected') continue;
    if (leftBinding?.selection !== rightBinding?.selection) return false;
    if ((leftBinding?.profileId ?? '') !== (rightBinding?.profileId ?? '')) return false;
    if ((leftBinding?.groupId ?? '') !== (rightBinding?.groupId ?? '')) return false;
  }
  return true;
}

function createServiceBindingsSignature(bindings: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>): string {
  return JSON.stringify(
    Object.keys(bindings)
      .sort()
      .map((serviceId) => {
        const binding = bindings[serviceId];
        if (binding?.source === 'team_resource') {
          return [
            serviceId,
            binding.source,
            binding.resourceId,
            binding.deliveryMode,
            teamResourceConnectedServiceSelectionKey(binding),
          ];
        }
        if (binding?.source !== 'connected') return [serviceId, binding?.source ?? ''];
        return [
          serviceId,
          binding?.source ?? '',
          binding?.selection ?? '',
          binding?.profileId ?? '',
          binding?.groupId ?? '',
        ];
      }),
  );
}

export function useNewSessionConnectedServices(params: Readonly<{
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
  settings: {
    connectedServicesProfileLabelByKey: Record<string, string | undefined>;
    connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
    /** The one Agent default-authentication store. */
    connectedAccountPurposeBindingsV1?: QualifiedConnectedAccountPurposeBindingsV1;
    /** Released service-keyed defaults, read only until their Agent is rewritten. */
    connectedServicesDefaultAuthByAgentIdV1?: ConnectedServicesDefaultAuthByAgentIdV1;
  };
  targetServerId: string | null;
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
        labelsByKey: settings.connectedServicesProfileLabelByKey,
        presentIdentity: present,
      }),
      connectedAccounts,
    })
  ), [accountProfile?.connectedAccountsV4, connectedAccounts, settings.connectedServicesProfileLabelByKey, supportedConnectedServiceIds, present]);

  const connectedServiceAccountGroupOptionsByServiceId = React.useMemo(() => (
    buildQualifiedConnectedAccountGroupOptionsByServiceId({
      groups: accountProfile?.connectedAccountGroupsV4 ?? [],
      supportedServiceIds: supportedConnectedServiceIds,
    })
  ), [accountProfile?.connectedAccountGroupsV4, supportedConnectedServiceIds]);

  const connectedServicesBindingsByServiceId = React.useMemo(() => {
    const explicitBindings = parseConnectedServicesBindingsByServiceIdFromAgentOptionState({ agentOptionState });
    const hasExplicitBindings = Boolean(
      agentOptionState
      && Object.prototype.hasOwnProperty.call(agentOptionState, CONNECTED_SERVICES_BINDINGS_KEY),
    );
    if (hasExplicitBindings) return explicitBindings;

    const agentId = typeof params.defaultAuthAgentId === 'string'
      ? params.defaultAuthAgentId.trim()
      : typeof agentCore?.id === 'string'
        ? agentCore.id.trim()
        : '';
    const consumer = params.defaultAuthConsumer ?? null;
    if (!agentId || !consumer) return explicitBindings;

    return projectAgentConnectedAccountPurposeDefaultsToSessionBindings(
      resolveAgentConnectedAccountPurposeDefaults({
        settings: {
          connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
          connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
        },
        agentId,
        consumer,
        declarations: connectedAccounts,
      }),
    )?.bindingsByServiceId ?? explicitBindings;
  }, [
    agentCore,
    agentOptionState,
    connectedAccounts,
    params.defaultAuthAgentId,
    params.defaultAuthConsumer,
    settings.connectedAccountPurposeBindingsV1,
    settings.connectedServicesDefaultAuthByAgentIdV1,
  ]);

  const [optimisticBindingsByServiceId, setOptimisticBindingsByServiceId] = React.useState(connectedServicesBindingsByServiceId);
  const connectedServicesBindingsSignature = React.useMemo(
    () => createServiceBindingsSignature(connectedServicesBindingsByServiceId),
    [connectedServicesBindingsByServiceId],
  );

  React.useEffect(() => {
    setOptimisticBindingsByServiceId((prev) =>
      areServiceBindingsEqual(prev, connectedServicesBindingsByServiceId)
        ? prev
        : connectedServicesBindingsByServiceId
    );
  }, [connectedServicesBindingsSignature]);

  const connectedServicesBindingsPayload = React.useMemo(() => {
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
    setOptimisticBindingsByServiceId((prev) => {
      const next = {
        ...prev,
        [serviceId]: binding,
      };
      setAgentOptionStateForCurrentAgent(CONNECTED_SERVICES_BINDINGS_KEY, next);
      return next;
    });
  }, [coordinateTeamCredentialSelection, params.applyTeamCredentialPolicy, setAgentOptionStateForCurrentAgent]);

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

  const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (supportedConnectedServiceIds.length === 0) return null;
        return createConnectedServicesAuthActionChip({
            label: authLabel.label,
            connectedCount: authLabel.connectedCount,
            authSource: authLabel.connectedCount === 0
                ? 'native'
                : authLabel.connectedCount === supportedConnectedServiceIds.length
                    ? 'connected'
                    : 'mixed',
            popoverContent: connectedServicesAuthPopoverContent,
            maxHeightCap: 560,
            maxWidthCap: 560,
        });
    }, [authLabel, connectedServicesAuthPopoverContent, supportedConnectedServiceIds]);

  return { connectedServicesBindingsPayload, connectedServicesModelProbeCacheIdentity, connectedServicesAuthChip };
}
