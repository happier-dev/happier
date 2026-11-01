import {
    buildQualifiedPluginContributionKey,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol/plugins/contribution-identity';
import type { ResolvedActionContribution, ResolvedContributionRegistry } from './types';

/** Reads the canonical admitted declaration without enumerating or re-admitting it. */
export function readResolvedActionContribution(
    registry: Pick<ResolvedContributionRegistry, 'actionsById'>,
    identity: PluginContributionIdentityV1,
): ResolvedActionContribution | null {
    return registry.actionsById?.get(buildQualifiedPluginContributionKey(identity)) ?? null;
}
