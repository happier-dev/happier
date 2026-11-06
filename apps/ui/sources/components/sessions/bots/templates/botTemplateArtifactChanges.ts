import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/** Observe the existing Home push, including shares that have no local Artifact row yet. */
export function subscribeBotTemplateArtifactChanges(binding: ServerCredentialAccountScopeBinding, refresh: () => void, artifactId?: string) {
    return subscribeHomeAccountChange(event => {
        if (!binding.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, binding.scope.serverId)) return;
        if (event.changeKinds && !event.changeKinds.includes('artifact')) return;
        if (artifactId && event.entityIds && !event.entityIds.includes(artifactId)
            && event.source !== 'connected' && event.source !== 'snapshot') return;
        refresh();
    }, { serverIds: [binding.scope.serverId], includeCatchUpPending: true, reconnect: 'refresh' });
}
