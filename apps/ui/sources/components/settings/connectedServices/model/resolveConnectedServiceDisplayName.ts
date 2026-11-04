import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { humanizeConnectedServiceIdentity } from '@/sync/domains/connectedServices/connectedServiceIdentityLabel';
import {
    getConnectedServiceRegistryIdentityFallback,
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
    localizePluginText?: PluginLocalizedTextResolver,
): string {
    const projectedTitle = resolveProjectedLocalizedText(
        entry.projectedTitle,
        entry.service && localizePluginText
            ? (value) => localizePluginText(entry.service!.pluginId, value)
            : undefined,
    );
    if (projectedTitle) {
        return projectedTitle;
    }
    if (entry.displayNameKey) return translate(entry.displayNameKey);
    return humanizeConnectedServiceIdentity(entry.service?.localId ?? entry.serviceId) || translate('connectedServices.fallbackName');
}

/**
 * A qualified service's entry in the daemon-published, currently applied descriptor projection, else
 * (before that projection arrives) its read-only identity entry. The registry
 * supplies admitted bundled titles without granting execution; installed
 * third-party manifests are never consulted as a substitute for a projection.
 */
export function resolveQualifiedConnectedServiceRegistryEntry(
    registry: Pick<ConnectedServiceRegistrySnapshot, 'entries'>,
    service: Readonly<{ pluginId: string; localId: string }>,
): ConnectedServiceRegistryEntry | null {
    return registry.entries.find((candidate) => (
        candidate.service?.pluginId === service.pluginId
        && candidate.service.localId === service.localId
    )) ?? getConnectedServiceRegistryIdentityFallback(service);
}

/** A qualified service's name, through `resolveQualifiedConnectedServiceRegistryEntry`. */
export function resolveQualifiedConnectedServiceRegistryDisplayName(
    registry: Pick<ConnectedServiceRegistrySnapshot, 'entries'>,
    service: Readonly<{ pluginId: string; localId: string }>,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
    localizePluginText?: PluginLocalizedTextResolver,
): string {
    const entry = resolveQualifiedConnectedServiceRegistryEntry(registry, service);
    const label = entry
        ? resolveConnectedServiceRegistryEntryDisplayName(entry, translate, localizePluginText)
        : humanizeConnectedServiceIdentity(service.localId) || translate('connectedServices.fallbackName');
    const collision = registry.entries.some(candidate => candidate.service
        && candidate.service.pluginId !== service.pluginId
        && resolveConnectedServiceRegistryEntryDisplayName(candidate, translate, localizePluginText) === label);
    return collision ? `${label} · ${service.pluginId}` : label;
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
