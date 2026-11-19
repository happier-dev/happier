import type { DaemonContributionRegistryProjectionAutomationEligibleEventV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
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

/** The name a catalog Event's plugin goes by: its installed package's name, else its projection title, else none. */
export function readEligibleEventPluginName(
    inputs: Pick<DaemonMergedProjectionInputs, 'pluginProjectionById' | 'pluginProjectionV2'> | null | undefined,
    pluginId: string,
): string | null {
    const candidate = inputs?.pluginProjectionV2?.installedPackagesById[pluginId] ?? null;
    const installed = candidate?.id === pluginId ? candidate : null;
    // A plugin is named by its display name; without one it goes unnamed, never by its raw id (#184 F3).
    return installed?.displayName ?? inputs?.pluginProjectionById[pluginId]?.title ?? null;
}
