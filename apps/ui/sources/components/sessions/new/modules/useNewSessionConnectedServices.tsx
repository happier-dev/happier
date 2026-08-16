import React from 'react';

import { t } from '@/text';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { createConnectedServicesAuthActionChip } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import {
  readConnectedServiceProfileKindFromServices,
  resolveConnectedServiceProfileActionRoute,
  type ConnectedServiceProfileActionRoute,
} from '@/sync/domains/connectedServices/resolveConnectedServiceProfileActionRoute';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProfile } from '@/sync/store/hooks';
import type { ConnectedServiceId } from '@happier-dev/agents';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import {
  resolveConnectedServicesAuthLabel,
  resolveConnectedServicesAuthWarningTranslationKey,
} from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import {
  CONNECTED_SERVICES_BINDINGS_KEY,
  type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import {
  type NewSessionConnectedServicesAgentCore,
  resolveNewSessionConnectedServicesBindingsForAgent,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import type { ConnectedServicesAuthWarningCode } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export type NewSessionConnectedServicesResult = Readonly<{
  connectedServicesBindingsPayload: ConnectedServiceBindingsV1 | null;
  connectedServicesAuthChip: AgentInputExtraActionChip | null;
}>;

function resolveDefaultAuthWarningLabel(warningCode: ConnectedServicesAuthWarningCode | undefined): string | undefined {
  const key = resolveConnectedServicesAuthWarningTranslationKey(warningCode);
  return key ? t(key) : undefined;
}

function buildConnectedServiceProfileSettingsPath(route: ConnectedServiceProfileActionRoute): string {
  if (!('params' in route)) return route.pathname;
  const searchParams = new URLSearchParams({
    serviceId: route.params.serviceId,
    profileId: route.params.profileId,
  });
  return `${route.pathname}?${searchParams.toString()}`;
}

export function useNewSessionConnectedServices(params: Readonly<{
  agentCore: NewSessionConnectedServicesAgentCore;
  agentOptionState: Record<string, unknown> | null;
  settings: {
    connectedServicesProfileLabelByKey: Record<string, string | undefined>;
    connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
    connectedServicesDefaultAuthByAgentIdV1?: unknown;
  };
  targetServerId: string | null;
  router: {
    push: (path: string | {
      pathname: string;
      params?: Record<string, string>;
    }) => void;
  };
  setAgentOptionStateForCurrentAgent: (key: string, value: unknown) => void;
}>): NewSessionConnectedServicesResult {
  const { agentCore, agentOptionState, settings, targetServerId, router, setAgentOptionStateForCurrentAgent } = params;
  const accountProfile = useProfile();
  const connectedServicesFeatureEnabled = useFeatureEnabled('connectedServices', {
    scopeKind: 'spawn',
    serverId: targetServerId,
  });
  const accountGroupsFeatureEnabled = useFeatureEnabled('connectedServices.accountGroups', {
    scopeKind: 'spawn',
    serverId: targetServerId,
  });
  const agentId = typeof agentCore?.id === 'string' ? agentCore.id.trim() : '';
  const baseConnectedServicesResolution = React.useMemo(() => {
    return resolveNewSessionConnectedServicesBindingsForAgent({
      agentId,
      agentCore,
      agentOptionState,
      accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
      settings,
      connectedServicesFeatureEnabled,
      accountGroupsFeatureEnabled,
    });
  }, [
    accountGroupsFeatureEnabled,
    accountProfile?.connectedServicesV2,
    agentCore,
    agentId,
    agentOptionState,
    connectedServicesFeatureEnabled,
    settings,
  ]);
  const [optimisticBindingsByServiceId, setOptimisticBindingsByServiceId] = React.useState(
    baseConnectedServicesResolution.connectedServicesBindingsByServiceId,
  );
  const baseConnectedServicesBindingsKey = React.useMemo(
    () => stableJsonStringify(baseConnectedServicesResolution.connectedServicesBindingsByServiceId),
    [baseConnectedServicesResolution.connectedServicesBindingsByServiceId],
  );

  React.useEffect(() => {
    setOptimisticBindingsByServiceId(baseConnectedServicesResolution.connectedServicesBindingsByServiceId);
  }, [baseConnectedServicesBindingsKey]);

  const connectedServicesResolution = React.useMemo(() => {
    return resolveNewSessionConnectedServicesBindingsForAgent({
      agentId,
      agentCore,
      agentOptionState,
      accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
      settings,
      connectedServicesFeatureEnabled,
      accountGroupsFeatureEnabled,
      connectedServicesBindingsByServiceIdOverride: optimisticBindingsByServiceId,
    });
  }, [
    accountGroupsFeatureEnabled,
    accountProfile?.connectedServicesV2,
    agentCore,
    agentId,
    agentOptionState,
    connectedServicesFeatureEnabled,
    optimisticBindingsByServiceId,
    settings,
  ]);
  const {
    supportedConnectedServiceIds,
    connectedServiceProfileOptionsByServiceId,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServicesBindingsPayload,
    accountGroupSwitchingEnabled,
  } = connectedServicesResolution;

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

  // Hoisted out of the render callback below: the selection content INVOKES this
  // during its list build and bakes the result into every option, so it stays a
  // dependency of that build. Recreated inline it changed identity on every
  // `renderContent(...)` pass and rebuilt the whole step tree; as a memoised
  // callback it changes only when the availability data actually does.
  const resolveOptionAvailability = React.useCallback(({ serviceId, optionId }: Readonly<{
    serviceId: string;
    optionId: string;
  }>) => {
    const binding = optimisticBindingsByServiceId[serviceId];
    if (
      binding?.source === 'connected'
      && binding.selection === 'group'
      && optionId === `connected-service:${encodeURIComponent(serviceId)}:group:${encodeURIComponent(binding.groupId)}`
      && !accountGroupSwitchingEnabled
    ) {
      return {
        disabled: true,
        subtitle: t('connectedServices.authModal.groupUnsupportedSubtitle'),
      };
    }
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
  }, [accountGroupSwitchingEnabled, authLabel, optimisticBindingsByServiceId]);

  const connectedServicesAuthPopoverContent = React.useCallback(({ requestClose, maxHeight }: AgentInputContentPopoverRenderArgs) => (
    <NewSessionConnectedServicesSelectionContent
      supportedServiceIds={supportedConnectedServiceIds}
      profileOptionsByServiceId={connectedServiceProfileOptionsByServiceId}
      accountGroupOptionsByServiceId={connectedServiceAccountGroupOptionsByServiceId}
      bindingsByServiceId={optimisticBindingsByServiceId}
      setBindingForService={setBindingForService}
      defaultProfileIdByServiceId={settings.connectedServicesDefaultProfileByServiceId}
      resolveOptionAvailability={resolveOptionAvailability}
      onOpenSettings={(serviceId) => {
        router.push({
          pathname: '/settings/connected-services/[serviceId]',
          params: { serviceId },
        });
      }}
      onReconnectProfile={(serviceId, profileId) => {
        const profile = connectedServiceProfileOptionsByServiceId[serviceId]?.find((option) => option.profileId === profileId);
        const profileKind = readConnectedServiceProfileKindFromServices({
          connectedServicesV2: accountProfile?.connectedServicesV2 ?? null,
          serviceId,
          profileId,
        }) ?? profile?.kind;
        router.push(buildConnectedServiceProfileSettingsPath(resolveConnectedServiceProfileActionRoute({
          serviceId,
          profileId,
          profileKind,
        })));
      }}
      requestClose={requestClose}
      maxHeight={maxHeight}
    />
  ), [
    accountProfile?.connectedServicesV2,
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
            authSource: authLabel.connectedCount > 0 ? 'connected' : 'native',
            connectedCount: authLabel.connectedCount,
            popoverContent: connectedServicesAuthPopoverContent,
            maxHeightCap: 560,
            maxWidthCap: 560,
        });
    }, [
      authLabel,
      connectedServicesAuthPopoverContent,
      supportedConnectedServiceIds,
    ]);

  return { connectedServicesBindingsPayload, connectedServicesAuthChip };
}
