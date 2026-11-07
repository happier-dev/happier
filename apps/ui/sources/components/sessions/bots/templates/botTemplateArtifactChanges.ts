import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { BOT_TEMPLATE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';

/** Observe the existing Home push, including shares that have no local Artifact row yet. */
export function subscribeBotTemplateArtifactChanges(binding: ServerCredentialAccountScopeBinding, refresh: () => void, artifactId?: string) {
    return subscribeHomeAccountChange(event => {
        if (!binding.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, binding.scope.serverId)) return;
        if (artifactId && event.entityIds && !event.entityIds.includes(artifactId)
            && event.source !== 'connected' && event.source !== 'snapshot') return;
        refresh();
    }, { serverIds: [binding.scope.serverId], artifactKinds: [BOT_TEMPLATE_ARTIFACT_KIND_V1], includeCatchUpPending: 'recovery', reconnect: 'refresh' });
}
