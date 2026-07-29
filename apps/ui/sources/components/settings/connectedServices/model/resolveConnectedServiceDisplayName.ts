import { getConnectedServiceRegistryEntry, type ConnectedServiceDisplayNameKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';

export function resolveConnectedServiceDisplayNameKey(serviceId: string): ConnectedServiceDisplayNameKey {
    return getConnectedServiceRegistryEntry(serviceId).displayNameKey ?? 'connectedServices.fallbackName';
}

export function resolveConnectedServiceDisplayName(
    serviceId: string,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
): string {
    const projectedTitle = getConnectedServiceRegistryEntry(serviceId).projectedTitle;
    if (projectedTitle) {
        return typeof projectedTitle === 'string' ? projectedTitle : projectedTitle.fallback;
    }
    return translate(resolveConnectedServiceDisplayNameKey(serviceId));
}

/**
 * Short, brand-only name for compact surfaces (the agent-input auth chip and the account-switch
 * transcript event), sourced from the connected-service registry (descriptor `ui.shortName`).
 * Unknown services fall back to the full localized display name.
 */
export function resolveConnectedServiceShortName(
    serviceId: string,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
): string {
    return getConnectedServiceRegistryEntry(serviceId).shortName ?? resolveConnectedServiceDisplayName(serviceId, translate);
}
