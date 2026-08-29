import {
  isConnectedServiceCredentialHealthStatusUsable,
  normalizeConnectedServiceCredentialHealthStatus,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
  type AccountProfile,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

/**
 * Projects the current authority behind an already-admitted Connected Services
 * binding. This is deliberately a read-only fact: callers retain ownership of
 * the lifecycle decision they make when the fact changes.
 *
 * Account profiles still expose the released V2 scalar service projection,
 * while current bindings carry qualified service keys. Normalize that seam in
 * the Connected Services domain so consumers cannot each reinterpret profile,
 * group, health, and generation state differently.
 */
export function createConnectedServiceBindingAuthorityFingerprint(params: Readonly<{
  bindings: ConnectedServiceBindingsV1 | null;
  connectedServices: AccountProfile['connectedServicesV2'];
}>): string {
  if (!params.bindings) return 'unbound';

  const servicesByQualifiedKey = new Map<
    string,
    AccountProfile['connectedServicesV2'][number]
  >();
  for (const service of params.connectedServices) {
    const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(service.serviceId);
    if (serviceKey && !servicesByQualifiedKey.has(serviceKey)) {
      servicesByQualifiedKey.set(serviceKey, service);
    }
  }
  const authority = Object.entries(params.bindings.bindingsByServiceId)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([serviceId, binding]) => {
      if (binding.source === 'native') {
        return { serviceId, source: 'native' as const };
      }

      const service = servicesByQualifiedKey.get(serviceId) ?? null;
      const profiles = service?.profiles ?? [];
      const readProfileAuthority = (profileId: string | null) => {
        const profile = profileId
          ? profiles.find((candidate) => candidate.profileId === profileId) ?? null
          : null;
        return {
          profileId,
          usable: profile !== null
            && isConnectedServiceCredentialHealthStatusUsable(
              normalizeConnectedServiceCredentialHealthStatus(profile.status),
            ),
        };
      };

      if (binding.selection !== 'group') {
        return {
          serviceId,
          source: 'connected' as const,
          selection: 'profile' as const,
          ...readProfileAuthority(binding.profileId),
        };
      }

      const group = service?.groups.find((candidate) => candidate.groupId === binding.groupId) ?? null;
      const activeProfileId = group?.activeProfileId ?? null;
      return {
        serviceId,
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: binding.groupId,
        boundProfileId: binding.profileId ?? null,
        generation: group?.generation ?? null,
        ...readProfileAuthority(activeProfileId),
      };
    });

  return stableJsonStringify(authority);
}
