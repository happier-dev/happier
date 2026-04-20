import type { ConnectedServiceId } from '@happier-dev/protocol';
import { getConnectedServiceRegistryEntry, type ConnectedServiceDisplayNameKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';

export function resolveConnectedServiceDisplayNameKey(serviceId: ConnectedServiceId): ConnectedServiceDisplayNameKey {
    return getConnectedServiceRegistryEntry(serviceId).displayNameKey ?? 'connectedServices.fallbackName';
}

export function resolveConnectedServiceDisplayName(
    serviceId: ConnectedServiceId,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
): string {
    return translate(resolveConnectedServiceDisplayNameKey(serviceId));
}
