import type { EphemeralUpdate } from '@happier-dev/protocol/updates';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

type Change = Extract<EphemeralUpdate, { type: 'local-service-public-preview-changed' }>;
type Scope = Readonly<{ serverId?: string | null; accountId?: string | null; machineId: string;
    previewId?: string | null; exposureId?: string | null }>;
const listeners = new Set<Readonly<{ scope: Scope; changed: () => void }>>();

/** Demand-owned invalidation only: no retained snapshots or authority decisions. */
export function subscribeLocalServicePublicPreviewChanges(scope: Scope, changed: () => void): () => void {
    const listener = { scope, changed };
    listeners.add(listener);
    // Reuse the Home connection owner's demand; changes and reconnect recovery have
    // their own typed observation below/in the shared store, with no Account-feed reads.
    const releaseHome = subscribeHomeAccountChange(() => {}, {
        serverIds: scope.serverId ? [scope.serverId] : [],
    });
    return () => { listeners.delete(listener); releaseHome(); };
}

export function notifyLocalServicePublicPreviewChange(input: Readonly<{
    serverId: string; accountId: string; change: Change;
}>): void {
    const serverId = resolveServerProfileScopeIdForIdentifier(input.serverId);
    for (const { scope, changed } of listeners) {
        if (resolveServerProfileScopeIdForIdentifier(scope.serverId) !== serverId
            || scope.accountId !== input.accountId || scope.machineId !== input.change.machineId
            || scope.previewId && scope.previewId !== input.change.previewId
            || scope.exposureId && scope.exposureId !== input.change.exposureId) continue;
        changed();
    }
}
