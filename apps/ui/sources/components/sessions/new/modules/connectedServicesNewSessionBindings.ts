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
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';

export {
  buildSharedConnectedServiceProfileOptionsByServiceId as buildConnectedServiceProfileOptionsByServiceId,
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

export function buildConnectedServicesBindingsPayload(params: Readonly<{
  /** Qualified keys on current callers; released bundled scalar ids are translated through the generated built-in mapping. */
  supportedConnectedServiceIds: ReadonlyArray<string>;
  connectedServiceProfileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
  connectedServiceAccountGroupOptionsByServiceId?: ConnectedServicesAccountGroupOptionsByServiceId;
  connectedServicesBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  defaultProfileByServiceId: Record<string, string | undefined>;
  accountGroupsFeatureEnabled?: boolean;
}>): ConnectedServiceBindingsV1 | null {
  if (params.supportedConnectedServiceIds.length === 0) return null;

  const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
  let connectedCount = 0;

  for (const requestedServiceId of params.supportedConnectedServiceIds) {
    // The wire contract carries canonical qualified keys only. Resolve every
    // declared service through the provenance-named legacy ingress and drop
    // anything unknown — never emit a bare local id.
    const serviceId = resolveQualifiedConnectedAccountServiceKey(requestedServiceId);
    if (!serviceId) continue;
    const options = params.connectedServiceProfileOptionsByServiceId[serviceId]
      ?? params.connectedServiceProfileOptionsByServiceId[requestedServiceId]
      ?? [];
    const binding = params.connectedServicesBindingsByServiceId[serviceId]
      ?? params.connectedServicesBindingsByServiceId[requestedServiceId];
    const resolution = resolveConnectedServiceSessionSelection({
      serviceId,
      binding: binding ?? { source: 'native' },
      availability: {
        kind: 'known',
        profileOptions: options,
        groupOptions: params.connectedServiceAccountGroupOptionsByServiceId?.[serviceId]
          ?? params.connectedServiceAccountGroupOptionsByServiceId?.[requestedServiceId]
          ?? [],
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
