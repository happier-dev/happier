import {
  buildConnectedServiceAccountGroupOptionsByServiceId as buildSharedConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId as buildSharedConnectedServiceProfileOptionsByServiceId,
  isConnectedServiceProfileOptionSelectable,
  isConnectedServiceProfileStatusSelectable,
  resolveAgentSupportedConnectedServiceIds,
  resolveConnectedServiceDefaultProfileId,
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

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
    const connected = options.filter(isConnectedServiceProfileOptionSelectable);
    const binding = params.connectedServicesBindingsByServiceId[serviceId];
    const mode = binding?.source === 'connected' ? 'connected' : 'native';

    if (mode === 'connected') {
      if (connected.length === 0) {
        bindingsByServiceId[serviceId] = { source: 'native' };
        continue;
      }
      const connectedProfileIds = connected.map((o) => o.profileId);
      if (binding?.selection === 'group') {
        if (params.accountGroupsFeatureEnabled === false) {
          bindingsByServiceId[serviceId] = { source: 'native' };
          continue;
        }

        const groupId = readString(binding.groupId);
        const selectedGroup = (params.connectedServiceAccountGroupOptionsByServiceId?.[serviceId] ?? [])
          .find((group) => group.groupId === groupId);
        const activeProfileId = readString(selectedGroup?.activeProfileId);
        if (
          selectedGroup
          && selectedGroup.status === 'ready'
          && activeProfileId
          && connectedProfileIds.includes(activeProfileId)
        ) {
          bindingsByServiceId[serviceId] = {
            source: 'connected',
            selection: 'group',
            groupId,
          };
          connectedCount += 1;
          continue;
        }

        bindingsByServiceId[serviceId] = { source: 'native' };
        continue;
      }

      const explicit = binding?.source === 'connected' && binding.selection === 'profile'
        ? readString(binding.profileId)
        : '';
      if (explicit && !connectedProfileIds.includes(explicit)) {
        bindingsByServiceId[serviceId] = { source: 'native' };
        continue;
      }
      const selected =
        explicit
          ? explicit
          : resolveConnectedServiceDefaultProfileId({
            serviceId,
            connectedProfileIds,
            defaultProfileByServiceId: params.defaultProfileByServiceId,
          }) ?? connected[0]!.profileId;
      if (!selected) {
        bindingsByServiceId[serviceId] = { source: 'native' };
        continue;
      }
      bindingsByServiceId[serviceId] = { source: 'connected', selection: 'profile', profileId: selected };
      connectedCount += 1;
      continue;
    }

    bindingsByServiceId[serviceId] = { source: 'native' };
  }

  return connectedCount > 0 ? ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId }) : null;
}
