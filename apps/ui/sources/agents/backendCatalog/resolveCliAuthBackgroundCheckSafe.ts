import { isAgentCliAuthBackgroundCheckSafe } from '@happier-dev/agents';
import { isPluginAgentCliAuthBackgroundCheckSafe } from '@happier-dev/protocol';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import type { MergedProviderProjectionEntry } from './mergedProjectionTypes';

/**
 * The catalog projection is the single UI owner of background auth-probe
 * safety. Daemon-projected Agents use their own manifest facts; only an
 * unprojected bundled Agent may use the build-time compatibility catalog.
 */
export function resolveCliAuthBackgroundCheckSafe(
    agentId: string,
    providerProjection: MergedProviderProjectionEntry | null,
): boolean {
    if (providerProjection) {
        return providerProjection.cli
            ? isPluginAgentCliAuthBackgroundCheckSafe(providerProjection.cli)
            : false;
    }
    return isBundledAgentId(agentId) && isAgentCliAuthBackgroundCheckSafe(agentId);
}
