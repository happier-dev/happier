import { BUNDLED_CANONICAL_AGENT_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { qualifyPluginContributionReferenceV1, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveConnectedAccountNativeLoginConstraintsV1 } from '@happier-dev/protocol/teams';
import type { ConnectedAccountUiProjectionEntryV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';

const agents = Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).flatMap(declaration => declaration.cli?.displayName ? [{
    identity: declaration.identity,
    title: declaration.cli.displayName,
    providerRequirements: declaration.providerRequirements,
    connectedAccounts: declaration.connectedAccounts.map(purpose => ({
        service: qualifyPluginContributionReferenceV1(purpose.service, declaration.identity.pluginId),
    })),
}] : []);

/** Static bundled declarations are available before a Machine or Account projection answers. */
export function readBundledAccountNativeLoginConstraints(service: PluginContributionIdentityV1): NonNullable<ConnectedAccountUiProjectionEntryV1['nativeLoginRequiredBy']> {
    return resolveConnectedAccountNativeLoginConstraintsV1(service, agents);
}
