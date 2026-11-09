import { normalizePluginBrowserProjection, type PluginBrowserProjectionModel } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonContributionRegistryProjection } from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';

export {
    EMPTY_PLUGIN_BROWSER_PROJECTION, normalizePluginBrowserProjection,
    type PluginBrowserProjectionEntry, type PluginBrowserTargetProjection,
    type PluginBrowserActionProjection, type PluginBrowserProjectionModel,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

export function resolvePluginBrowserProjectionState(
    previous: PluginBrowserProjectionModel,
    projection: DaemonContributionRegistryProjection | null,
): PluginBrowserProjectionModel {
    if (projection === null) {
        return previous;
    }
    return normalizePluginBrowserProjection(projection);
}
