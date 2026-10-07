import { ConnectedServiceBindingsV2IngressSchema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedAccountServiceKey, ConnectedServiceBindingsV2 } from '@happier-dev/protocol';

import { readConnectedServiceChildSelectionsFromEnv, type ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';

export function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV2 {
  const parsed = ConnectedServiceBindingsV2IngressSchema.safeParse(raw);
  return parsed.success ? parsed.data : { v: 2, bindingsByServiceId: {} };
}

export function readConnectedServiceCredentialApplicationState(input: Readonly<{
  serviceId: ConnectedAccountServiceKey;
  connectedServicesBindingsRaw: unknown;
  connectedServiceSelectionsEnv?: NodeJS.ProcessEnv;
}>): Readonly<{
  serviceId: ConnectedAccountServiceKey;
  bindings: ConnectedServiceBindingsV2;
  binding: ConnectedServiceBindingsV2['bindingsByServiceId'][string] | undefined;
  childSelection: ConnectedServiceChildSelection | null;
}> | null {
  const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(input.serviceId);
  if (!serviceId) return null;
  const bindings = readConnectedServiceBindingsOrEmpty(input.connectedServicesBindingsRaw);
  return {
    serviceId,
    bindings,
    binding: bindings.bindingsByServiceId[serviceId],
    childSelection: readConnectedServiceChildSelectionsFromEnv(input.connectedServiceSelectionsEnv ?? {})?.get(serviceId) ?? null,
  };
}
