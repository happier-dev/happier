import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { EphemeralUpdate } from '@happier-dev/protocol/updates';

import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { invalidateProviderConnectionUsage } from '@/sync/domains/connectedServices/accountUsage/providerConnectionUsageRefreshResource';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/** Accounting/capture facts invalidate Usage without implying a Follow or Session change. */
export function applyUsageSocketUpdate(
    update: Extract<EphemeralUpdate, { type: 'usage' | 'usage-sources-invalidated' }>,
    serverId: string,
    accountId: string | null,
): void {
    const scope = getActiveServerAccountScope();
    if (update.type === 'usage' && update.providerConnectionId && scope
        && accountId === scope.accountId && areServerProfileIdentifiersEquivalent(scope.serverId, serverId)) {
        invalidateProviderConnectionUsage({ ...scope, connectionId: update.providerConnectionId,
            ...(update.machineId ? { machineId: update.machineId } : {}) });
    }
    // Preserve the existing Account accounting/source-capture reader wake.
    publishHomeAccountChange(serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
}
