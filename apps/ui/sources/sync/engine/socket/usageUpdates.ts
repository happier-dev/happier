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
    // Usage changes Account accounting, not configuration or Session membership.
    // Actual allowance writes retain their own durable Account-change key;
    // the ephemeral payload is never admitted as a second accounting projection.
    // Source capture/status settles independently of accounting. Ingest already
    // publishes its own usage event; a source-only wake changes no query answer.
    publishHomeAccountChange(serverId, [], { changeKinds: ['account'], usageQueryAffects: update.type === 'usage',
        sessionReadinessChanges: { sessionIds: [], machineIds: [] },
        ...(update.type === 'usage' && update.accountingChange ? { usageAccountingChange: update.accountingChange } : {}),
        ...(update.type === 'usage-sources-invalidated' ? { usageSourcesMachineIds: [update.machineId] } : {}),
        machineResourcesAffect: false,
        accountSettingsAffects: false, profileCatalogAffects: false, publicProfileAffects: false, sessionListQueryAffects: false,
        discussionAffects: false, savedSecretCatalogAffects: false });
}
