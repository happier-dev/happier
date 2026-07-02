import React from 'react';

import { t } from '@/text';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { createConnectedServicesAuthActionChip } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { FeatureDecisionScopeParams } from '@/hooks/server/useFeatureDecision';
import { useProfile } from '@/sync/store/hooks';
import type { ConnectedServiceId } from '@happier-dev/agents';
import {
  ConnectedServicesDefaultAuthByAgentIdV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServicesDefaultAuthByAgentIdV1,
} from '@happier-dev/protocol';

import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import {
  resolveConnectedServicesAuthLabel,
  resolveConnectedServicesAuthWarningTranslationKey,
  type ConnectedServicesAuthWarningCode,
} from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import {
  CONNECTED_SERVICES_BINDINGS_KEY,
  type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import {
  buildConnectedServiceProfileOptionsByServiceId,
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
  resolveAgentSupportedConnectedServiceIds,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

export type NewSessionConnectedServicesResult = Readonly<{
  connectedServicesBindingsPayload: ConnectedServiceBindingsV1 | null;
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

function buildConnectedServiceProfileSettingsPath(params: Readonly<{
  pathname: '/settings/connected-services/oauth' | '/settings/connected-services/profile';
  serviceId: string;
  profileId: string;
}>): string {
  const query = new URLSearchParams({
    serviceId: params.serviceId,
    profileId: params.profileId,
  });
  return `${params.pathname}?${query.toString()}`;
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
  agentCore: any;
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
  const { agentCore, agentOptionState, settings, targetServerId, router, setAgentOptionStateForCurrentAgent } = params;
  const accountProfile = useProfile();
  const connectedServicesFeatureScope = React.useMemo<FeatureDecisionScopeParams | undefined>(() => {
    const trimmedTargetServerId = targetServerId?.trim() ?? '';
    if (!trimmedTargetServerId) return undefined;
    return { scopeKind: 'spawn', serverId: trimmedTargetServerId };
  }, [targetServerId]);
  const connectedServicesFeatureEnabled = useFeatureEnabled('connectedServices', connectedServicesFeatureScope);
  const accountGroupsFeatureEnabled = useFeatureEnabled('connectedServices.accountGroups', connectedServicesFeatureScope);

  const supportedConnectedServiceIds = React.useMemo<ReadonlyArray<ConnectedServiceId>>(() => {
    return resolveAgentSupportedConnectedServiceIds({
      connectedServicesFeatureEnabled,
      agentCore,
    });
  }, [agentCore, connectedServicesFeatureEnabled]);

  const connectedServiceProfileOptionsByServiceId = React.useMemo(() => {
    return buildConnectedServiceProfileOptionsByServiceId({
      accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
      agentCore,
      supportedConnectedServiceIds,
      labelsByKey: settings.connectedServicesProfileLabelByKey,
    });
  }, [accountProfile, agentCore, settings.connectedServicesProfileLabelByKey, supportedConnectedServiceIds]);

  const connectedServiceAccountGroupOptionsByServiceId = React.useMemo(() => {
    return buildConnectedServiceAccountGroupOptionsByServiceId({
      accountGroupsFeatureEnabled,
      accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
      supportedConnectedServiceIds,
    });
  }, [accountGroupsFeatureEnabled, accountProfile, supportedConnectedServiceIds]);

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

  const authLabel = React.useMemo(() => resolveConnectedServicesAuthLabel({
    supportedServiceIds: supportedConnectedServiceIds,
    bindingsByServiceId: optimisticBindingsByServiceId,
    profileOptionsByServiceId: connectedServiceProfileOptionsByServiceId,
    accountGroupOptionsByServiceId: connectedServiceAccountGroupOptionsByServiceId,
    accountGroupsEnabled: accountGroupsFeatureEnabled,
    defaultProfileIdByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    resolveServiceTitle: (serviceId) => resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t),
    nativeLabel: t('connectedServices.authChip.nativeLabel'),
    formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
  }), [
    accountGroupsFeatureEnabled,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServiceProfileOptionsByServiceId,
    optimisticBindingsByServiceId,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
  ]);

  const connectedServicesAuthPopoverContent = React.useCallback(({ maxHeight }: AgentInputContentPopoverRenderArgs) => (
    <NewSessionConnectedServicesSelectionContent
      supportedServiceIds={supportedConnectedServiceIds}
      profileOptionsByServiceId={connectedServiceProfileOptionsByServiceId}
      groupOptionsByServiceId={connectedServiceAccountGroupOptionsByServiceId}
      bindingsByServiceId={optimisticBindingsByServiceId}
      setBindingForService={setBindingForService}
      defaultProfileIdByServiceId={settings.connectedServicesDefaultProfileByServiceId}
      resolveOptionAvailability={({ serviceId, optionId }) => {
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
      }}
      onOpenSettings={() => {
        router.push('/settings/connected-services');
      }}
      onReconnectProfile={(serviceId, profileId) => {
        const profile = connectedServiceProfileOptionsByServiceId[serviceId]?.find((option) => option.profileId === profileId);
        if (profile?.kind === 'token') {
          router.push(buildConnectedServiceProfileSettingsPath({
            pathname: '/settings/connected-services/profile',
            serviceId,
            profileId,
          }));
          return;
        }
        router.push(buildConnectedServiceProfileSettingsPath({
          pathname: '/settings/connected-services/oauth',
          serviceId,
          profileId,
        }));
      }}
      maxHeight={maxHeight}
    />
  ), [
    authLabel,
    connectedServiceProfileOptionsByServiceId,
    connectedServiceAccountGroupOptionsByServiceId,
    optimisticBindingsByServiceId,
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

  return { connectedServicesBindingsPayload, connectedServicesAuthChip };
}
