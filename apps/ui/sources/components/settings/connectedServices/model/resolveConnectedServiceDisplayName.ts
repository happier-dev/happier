import {
    getLegacyConnectedServiceRegistryEntry,
    type ConnectedServiceDisplayNameKey,
    type ConnectedServiceRegistryEntry,
    type ConnectedServiceRegistrySnapshot,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';

export function resolveConnectedServiceDisplayNameKey(serviceId: string): ConnectedServiceDisplayNameKey {
    return getLegacyConnectedServiceRegistryEntry(serviceId).displayNameKey ?? 'connectedServices.fallbackName';
}

export function resolveConnectedServiceRegistryEntryDisplayName(
    entry: ConnectedServiceRegistryEntry,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
): string {
    const projectedTitle = entry.projectedTitle;
    if (projectedTitle) {
        return typeof projectedTitle === 'string' ? projectedTitle : projectedTitle.fallback;
    }
    return translate(entry.displayNameKey ?? 'connectedServices.fallbackName');
}

/**
 * Resolve a qualified service from the daemon-published, currently applied
 * descriptor projection. Callers must not infer a presentation title from an
 * installed plugin manifest: it may not be current or executable for this
 * server scope.
 */
export function resolveQualifiedConnectedServiceRegistryDisplayName(
    registry: Pick<ConnectedServiceRegistrySnapshot, 'entries'>,
    service: Readonly<{ pluginId: string; localId: string }>,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
): string {
    const entry = registry.entries.find((candidate) => (
        candidate.service?.pluginId === service.pluginId
        && candidate.service.localId === service.localId
    ));
    return entry
        ? resolveConnectedServiceRegistryEntryDisplayName(entry, translate)
        : translate('connectedServices.fallbackName');
}

export function resolveConnectedServiceDisplayName(
    serviceId: string,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
): string {
    return resolveConnectedServiceRegistryEntryDisplayName(
        getLegacyConnectedServiceRegistryEntry(serviceId),
        translate,
    );
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
    return getLegacyConnectedServiceRegistryEntry(serviceId).shortName
        ?? resolveConnectedServiceDisplayName(serviceId, translate);
}
