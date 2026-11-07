import type { DaemonContributionRegistryProjectionAutomationEligibleEventV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

export type EligibleEventPresentation = Readonly<{ title: string; description: string | null }>;

/**
 * The person-facing name of a catalog Event: its localized descriptors when the catalog carries them,
 * else the declared strings. Every Event is presented the same way; none is special-cased.
 */
export function readEligibleEventPresentation(
    entry: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    localize: PluginLocalizedTextResolver,
): EligibleEventPresentation {
    const { event } = entry;
    const localized = event.localizedPresentation;
    const pluginId = event.identity.pluginId;
    return {
        title: localized ? localize(pluginId, localized.title) : event.title,
        description: localized?.description ? localize(pluginId, localized.description) : event.description,
    };
}
