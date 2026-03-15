import React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Modal } from '@/modal';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/AgentInput';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProfile } from '@/sync/store/hooks';
import type { ConnectedServiceId } from '@happier-dev/agents';

import {
  ConnectedServicesAuthModal,
  CONNECTED_SERVICES_BINDINGS_KEY,
  type ConnectedServicesServiceBinding,
} from '@/components/sessions/new/components/ConnectedServicesAuthModal';
import {
  buildConnectedServiceProfileOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
  parseConnectedServicesBindingsByServiceIdFromAgentOptionState,
  resolveAgentSupportedConnectedServiceIds,
  type ConnectedServicesBindingsPayloadV1,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';

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
    const label =
      connectedCount > 0
        ? t('connectedServices.authChip.labelWithCount', { count: connectedCount })
        : t('connectedServices.authChip.label');
    return {
      key: 'new-session-connected-services-auth',
      render: ({ chipStyle, iconColor, showLabel, textStyle }) => (
        <Pressable
          onPress={openConnectedServicesAuthModal}
          hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
          style={(p) => chipStyle(p.pressed)}
        >
          <Ionicons name="key-outline" size={16} color={iconColor} />
          {showLabel ? (
            <Text numberOfLines={1} style={textStyle}>
              {label}
            </Text>
          ) : null}
        </Pressable>
      ),
    };
  }, [connectedServicesBindingsByServiceId, openConnectedServicesAuthModal, supportedConnectedServiceIds]);

  return { connectedServicesBindingsPayload, connectedServicesAuthChip };
}
