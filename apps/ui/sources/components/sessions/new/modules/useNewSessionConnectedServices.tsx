import React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createConnectedServicesAuthActionChip } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProfile } from '@/sync/store/hooks';
import type { ConnectedServiceId } from '@happier-dev/agents';

import {
  ConnectedServicesAuthModal,
} from '@/components/sessions/new/components/ConnectedServicesAuthModal';
import {
  CONNECTED_SERVICES_BINDINGS_KEY,
  type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import {
  buildConnectedServiceProfileOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
  resolveAgentSupportedConnectedServiceIds,
  type ConnectedServicesBindingsPayloadV1,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

export type NewSessionConnectedServicesResult = Readonly<{
  connectedServicesBindingsPayload: ConnectedServicesBindingsPayloadV1 | null;
  connectedServicesAuthChip: AgentInputExtraActionChip | null;
}>;

export function useNewSessionConnectedServices(params: Readonly<{
  agentCore: any;
  agentOptionState: Record<string, unknown> | null;
  settings: {
    connectedServicesProfileLabelByKey: Record<string, string | undefined>;
    connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
  };
  router: { push: (path: any) => void };
  setAgentOptionStateForCurrentAgent: (key: string, value: unknown) => void;
}>): NewSessionConnectedServicesResult {
  const { agentCore, agentOptionState, settings, router, setAgentOptionStateForCurrentAgent } = params;
  const accountProfile = useProfile();
  const connectedServicesFeatureEnabled = useFeatureEnabled('connectedServices');

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

  const connectedServicesBindingsByServiceId = React.useMemo(() => {
    return parseConnectedServicesBindingsByServiceIdFromAgentOptionState({ agentOptionState });
  }, [agentOptionState]);

  const connectedServicesBindingsPayload = React.useMemo(() => {
    return buildConnectedServicesBindingsPayload({
      supportedConnectedServiceIds,
      connectedServiceProfileOptionsByServiceId,
      connectedServicesBindingsByServiceId,
      defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    });
  }, [
    connectedServiceProfileOptionsByServiceId,
    connectedServicesBindingsByServiceId,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
  ]);

  const openConnectedServicesAuthModal = React.useCallback(() => {
    if (supportedConnectedServiceIds.length === 0) return;

    Modal.show({
      component: ConnectedServicesAuthModal,
      props: {
        supportedServiceIds: supportedConnectedServiceIds,
        profileOptionsByServiceId: connectedServiceProfileOptionsByServiceId,
        bindingsByServiceId: connectedServicesBindingsByServiceId,
        setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => {
          setAgentOptionStateForCurrentAgent(CONNECTED_SERVICES_BINDINGS_KEY, {
            ...connectedServicesBindingsByServiceId,
            [serviceId]: binding,
          });
        },
        defaultProfileIdByServiceId: settings.connectedServicesDefaultProfileByServiceId,
        onOpenSettings: () => router.push('/(app)/settings/connected-services'),
      },
    });
  }, [
    connectedServiceProfileOptionsByServiceId,
    connectedServicesBindingsByServiceId,
    router,
    setAgentOptionStateForCurrentAgent,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
  ]);

  const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (supportedConnectedServiceIds.length === 0) return null;
        const connectedCount = supportedConnectedServiceIds.filter(
            (serviceId) => connectedServicesBindingsByServiceId[serviceId]?.source === 'connected',
        ).length;
        const label = t('connectedServices.authChip.label');
        return createConnectedServicesAuthActionChip({
            label,
            connectedCount,
            onPress: openConnectedServicesAuthModal,
        });
    }, [connectedServicesBindingsByServiceId, openConnectedServicesAuthModal, supportedConnectedServiceIds]);

  return { connectedServicesBindingsPayload, connectedServicesAuthChip };
}
