import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';

export function projectProviderObservedAccountMetadata(
  metadata: Record<string, unknown>,
  observation: Readonly<{ serviceId: ConnectedAccountServiceKey; groupId: string; profileId: string }>,
): Record<string, unknown> {
  const parsed = ConnectedServiceBindingsV2IngressSchema.safeParse(metadata.connectedServices);
  if (!parsed.success) return metadata;
  const binding = parsed.data.bindingsByServiceId[observation.serviceId];
  if (binding?.source !== 'connected' || binding.selection !== 'group'
    || binding.groupId !== observation.groupId || binding.appliedProfileId === observation.profileId) return metadata;
  return {
    ...metadata,
    connectedServices: {
      ...parsed.data,
      bindingsByServiceId: {
        ...parsed.data.bindingsByServiceId,
        [observation.serviceId]: { ...binding, appliedProfileId: observation.profileId },
      },
    },
  };
}
