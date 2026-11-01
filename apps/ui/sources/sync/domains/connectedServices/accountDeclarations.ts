import type { PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { ConnectedAccountSourceCustodyV1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';

export type AccountConnectedServiceDeclaration = Readonly<{
    service: Readonly<{ pluginId: string; localId: string }>;
    descriptor: PluginConnectedAccountDescriptorContributionV2;
    occurrenceId: string;
    sourceCustody: ConnectedAccountSourceCustodyV1;
}>;

/** Metadata from the same current Account selection that admits its executable. */
export function readUiAccountConnectedServiceDeclarations(accountLifetime: ActiveServerAccountScopeLifetime): readonly AccountConnectedServiceDeclaration[] {
    if (!accountLifetime.isCurrent()) return [];
    return readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecutionDeclarations().flatMap(selected =>
        (selected.manifest.contributes.connectedAccountDescriptors ?? []).map(descriptor => ({
            service: { pluginId: selected.manifest.id, localId: descriptor.id }, descriptor,
            occurrenceId: selected.custodyId, sourceCustody: selected.sourceCustody,
        })));
}
