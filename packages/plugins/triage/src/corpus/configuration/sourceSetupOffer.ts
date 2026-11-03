import type { TriageConfigureSourceOfferV1, TriageSourceDescriptorV1 } from '@happier-dev/triage-protocol/v1';

/** The admitted contributor qualifies its own declared page, never another plugin's destination. */
export function createTriageConfigureSourceOfferV1(
    contributorPluginId: string,
    descriptor: TriageSourceDescriptorV1,
): TriageConfigureSourceOfferV1 | undefined {
    if (descriptor.settingsPageId === undefined) return undefined;
    return Object.freeze({
        destination: Object.freeze({ pluginId: contributorPluginId, localId: descriptor.settingsPageId }),
        displayName: descriptor.displayName,
        kindNames: Object.freeze(descriptor.kinds.map(kind => kind.pluralDisplayName ?? kind.displayName)),
    });
}
