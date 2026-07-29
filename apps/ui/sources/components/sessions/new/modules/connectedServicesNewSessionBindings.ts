import {
  buildConnectedServiceAccountGroupOptionsByServiceId as buildSharedConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId as buildSharedConnectedServiceProfileOptionsByServiceId,
  isConnectedServiceProfileOptionSelectable,
  isConnectedServiceProfileStatusSelectable,
  resolveAgentSupportedConnectedServiceIds,
  resolveConnectedServiceSessionSelection,
  type ConnectedServiceId,
  type ConnectedServicesAccountGroupOptionsByServiceId,
  type ConnectedServicesProfileOption,
  type ConnectedServicesProfileOptionsByServiceId,
} from '@happier-dev/agents';
import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingSelectionV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

function resolveUnsupportedProfileSubtitleKey(serviceId: ConnectedServiceId):
  | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
  | 'connectedServices.detail.connectSetupTokenSubtitle' {
  const entry = getConnectedServiceRegistryEntry(serviceId);
  return entry.supportsToken && entry.tokenKind === 'setup-token'
    ? 'connectedServices.detail.connectSetupTokenSubtitle'
    : 'connectedServices.defaultAuth.warning.connected_service_unsupported';
}

export {
  buildConnectedServiceProfileOptionsByServiceId,
  buildSharedConnectedServiceAccountGroupOptionsByServiceId as buildConnectedServiceAccountGroupOptionsByServiceId,
  isConnectedServiceProfileOptionSelectable,
  isConnectedServiceProfileStatusSelectable,
  resolveAgentSupportedConnectedServiceIds,
};

export type {
  ConnectedServicesAccountGroupOptionsByServiceId,
  ConnectedServicesProfileOption,
  ConnectedServicesProfileOptionsByServiceId,
};

function buildConnectedServiceProfileOptionsByServiceId(
  params: Parameters<typeof buildSharedConnectedServiceProfileOptionsByServiceId>[0],
): ConnectedServicesProfileOptionsByServiceId {
  return buildSharedConnectedServiceProfileOptionsByServiceId({
    ...params,
    resolveUnsupportedSubtitleKey: resolveUnsupportedProfileSubtitleKey,
  });
}

export function buildConnectedServicesBindingsPayload(params: Readonly<{
  supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
  connectedServiceProfileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
  connectedServiceAccountGroupOptionsByServiceId?: ConnectedServicesAccountGroupOptionsByServiceId;
  connectedServicesBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  defaultProfileByServiceId: Record<string, string | undefined>;
  accountGroupsFeatureEnabled?: boolean;
}>): ConnectedServiceBindingsV1 | null {
  if (params.supportedConnectedServiceIds.length === 0) return null;

  const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
  let connectedCount = 0;

  for (const serviceId of params.supportedConnectedServiceIds) {
    const options = params.connectedServiceProfileOptionsByServiceId[serviceId] ?? [];
    const binding = params.connectedServicesBindingsByServiceId[serviceId];
    const resolution = resolveConnectedServiceSessionSelection({
      serviceId,
      binding: binding ?? { source: 'native' },
      availability: {
        kind: 'known',
        profileOptions: options,
        groupOptions: params.connectedServiceAccountGroupOptionsByServiceId?.[serviceId] ?? [],
        accountGroupsEnabled: params.accountGroupsFeatureEnabled !== false,
      },
      defaultProfileByServiceId: params.defaultProfileByServiceId,
    });

    if (resolution.status !== 'no_selection') {
      bindingsByServiceId[serviceId] = {
        source: 'connected',
        ...resolution.selection,
      };
      connectedCount += 1;
      continue;
    }

    bindingsByServiceId[serviceId] = { source: 'native' };
  }

  return connectedCount > 0 ? ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId }) : null;
}
