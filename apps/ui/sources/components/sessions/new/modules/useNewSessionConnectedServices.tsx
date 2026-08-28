import React from 'react';

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
import type { AgentCore, ConnectedServiceId } from '@happier-dev/agents';
import {
  buildQualifiedPluginContributionKey,
  parseQualifiedPluginContributionKey,
  ConnectedServicesDefaultAuthByAgentIdV1Schema,
  type ConnectedAccountServiceKey,
  type ConnectedServiceBindingsV1,
  type ConnectedServicesDefaultAuthByAgentIdV1,
  type PluginProjectedAgentConnectedAccountPurposeV2,
} from '@happier-dev/protocol';

import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import {
  resolveConnectedServiceDisplayName,
  resolveQualifiedConnectedServiceRegistryDisplayName,
} from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import {
  resolveConnectedServicesAuthLabel,
  resolveConnectedServicesAuthWarningTranslationKey,
  type ConnectedServicesAuthWarningCode,
} from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import {
  CONNECTED_SERVICES_BINDINGS_KEY,
  type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { getQualifiedConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
  applyAgentKindRestrictionsToQualifiedProfileOptions,
  buildQualifiedConnectedAccountGroupOptionsByServiceId,
  buildQualifiedConnectedAccountProfileOptionsByServiceId,
  resolveProjectedConnectedAccountServiceKeys,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import {
  buildConnectedServicesBindingsPayload,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

export type NewSessionConnectedServicesResult = Readonly<{
  connectedServicesBindingsPayload: ConnectedServiceBindingsV1 | null;
  connectedServicesModelProbeCacheIdentity: string | null;
  connectedServicesAuthChip: AgentInputExtraActionChip | null;
}>;

const EMPTY_DEFAULT_AUTH_SETTINGS: ConnectedServicesDefaultAuthByAgentIdV1 = {
  v: 1,
  bindingsByAgentId: {},
};

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
   * Exact Connected Account declarations from the authoritative machine Agent
   * catalog projection. Supported services are the canonical qualified keys of
   * these declarations — never a bundled scalar enum.
   */
  connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
  agentOptionState: Record<string, unknown> | null;
  settings: {
    connectedServicesProfileLabelByKey: Record<string, string | undefined>;
    connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
    connectedServicesDefaultAuthByAgentIdV1?: ConnectedServicesDefaultAuthByAgentIdV1;
  };
  targetServerId: string | null;
  router: { push: (path: any) => void };
  setAgentOptionStateForCurrentAgent: (key: string, value: unknown) => void;
}>): NewSessionConnectedServicesResult {
  const { agentCore, connectedAccounts, agentOptionState, settings, targetServerId, router, setAgentOptionStateForCurrentAgent } = params;
  const accountProfile = useProfile();
  const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
  const connectedServicesFeatureScope = React.useMemo<FeatureDecisionScopeParams | undefined>(() => {
    const trimmedTargetServerId = targetServerId?.trim() ?? '';
    if (!trimmedTargetServerId) return undefined;
    return { scopeKind: 'spawn', serverId: trimmedTargetServerId };
  }, [targetServerId]);
  const accountGroupsFeatureEnabled = useFeatureEnabled('connectedServices.accountGroups', connectedServicesFeatureScope);

  const supportedConnectedServiceIds = React.useMemo<ReadonlyArray<ConnectedAccountServiceKey>>(() => (
    resolveProjectedConnectedAccountServiceKeys(connectedAccounts)
  ), [connectedAccounts]);

  const connectedServiceProfileOptionsByServiceId = React.useMemo(() => (
    applyAgentKindRestrictionsToQualifiedProfileOptions({
      optionsByServiceId: buildQualifiedConnectedAccountProfileOptionsByServiceId({
        accounts: accountProfile?.connectedAccountsV4 ?? [],
        supportedServiceIds: supportedConnectedServiceIds,
        labelsByKey: settings.connectedServicesProfileLabelByKey,
      }),
      agentCore,
    })
  ), [accountProfile?.connectedAccountsV4, agentCore, settings.connectedServicesProfileLabelByKey, supportedConnectedServiceIds]);

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

    const defaultAuthSettings = ConnectedServicesDefaultAuthByAgentIdV1Schema.parse(
      settings.connectedServicesDefaultAuthByAgentIdV1 ?? EMPTY_DEFAULT_AUTH_SETTINGS,
    );
    const agentId = typeof agentCore?.id === 'string' ? agentCore.id.trim() : '';
    if (!agentId) return explicitBindings;

    return defaultAuthSettings.bindingsByAgentId[agentId]?.bindingsByServiceId ?? explicitBindings;
  }, [agentCore, agentOptionState, settings.connectedServicesDefaultAuthByAgentIdV1]);

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
    });
  }, [
    accountGroupsFeatureEnabled,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServiceProfileOptionsByServiceId,
    optimisticBindingsByServiceId,
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

  const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
    setOptimisticBindingsByServiceId((prev) => {
      const next = {
        ...prev,
        [serviceId]: binding,
      };
      setAgentOptionStateForCurrentAgent(CONNECTED_SERVICES_BINDINGS_KEY, next);
      return next;
    });
  }, [setAgentOptionStateForCurrentAgent]);

  /** Public applied-descriptor title; neutral fallback for an unknown service. */
  const resolveServiceTitle = React.useCallback((serviceId: string) => {
    const service = parseQualifiedPluginContributionKey(serviceId);
    return service
      ? resolveQualifiedConnectedServiceRegistryDisplayName(connectedServicesRegistry, service, t)
      : resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t);
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
