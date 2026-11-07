import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { readResolvedActionContribution } from '../actions';
import type { ResolvedActionContribution, ResolvedContributionRegistry } from '../types';

/** Select from the held admitted registry; never load the ambient Action inventory. */
export function readMountedActionContributions(
    registry: ResolvedContributionRegistry,
    actions: readonly PluginContributionIdentityV1[],
    callerPluginIds: readonly string[],
): ResolvedActionContribution[] {
    const callers = new Set(callerPluginIds);
    // A cold caller has no ambient Action IDs. Explicit IDs additionally select
    // cross-plugin callees, not every Action declared by those callee plugins.
    const selected = new Map<string, ResolvedActionContribution>();
    for (const action of registry.actions) {
        if (action.pluginId !== undefined && callers.has(action.pluginId)) {
            selected.set(buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.definition.id }), action);
        }
    }
    for (const identity of actions) {
        const action = readResolvedActionContribution(registry, identity);
        if (action) selected.set(buildQualifiedPluginContributionKey(identity), action);
    }
    return [...selected.values()];
}
