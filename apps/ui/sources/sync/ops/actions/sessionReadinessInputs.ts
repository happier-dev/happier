import { AGENT_IDS, getAgentResumeConfig } from '@happier-dev/agents';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { subscribeStoragePaths } from '@/sync/domains/state/storageSubscriptions';

// Admitted selection inputs consumed by sessionStatusAction. Access has its own
// addressed Home fact, so hydration of that change must not acquire status twice.
const metadataPaths: readonly (readonly string[])[] = [
    ['machineId'], ['host'], ['homeDir'], ['path'], ['sessionWorkspaceLocationV1'],
    ['flavor'], ['agent'], ['agentRuntimeDescriptorV1'], ['externalSessionV1'],
    ['sessionCreationCorrespondenceV1', 'recipe', 'agentTarget'],
    ['acpConfiguredBackendV1', 'backendId'], ['connectedServices'],
    ['modelSelectionIntentV1'], ['modelSelectionIntentV2'], ['modelOverrideV1'], ['providerBindingV1'],
    ...['sessionModelsV1', 'acpSessionModelsV1'].flatMap(key => [
        [key, 'v'], [key, 'agentId'], [key, 'currentModelId'], [key, 'activeSelectionV1'],
    ]),
    ...AGENT_IDS.flatMap(agentId => {
        const resume = getAgentResumeConfig(agentId);
        return 'vendorResumeIdField' in resume && resume.vendorResumeIdField ? [[resume.vendorResumeIdField]] : [];
    }),
];

/** Observe selected facts through the existing keyed publication index, without another store. */
export function subscribeUiSessionReadinessInputs(scope: ServerAccountScope, sessionId: string, notify: () => void): () => void {
    const paths = [
        ['serverId'], ['active'], ['acceptedTeamCredentialBinding'], ['metadataLayoutVersion'],
        ...['metadata', 'ownerMetadataView'].flatMap(key => metadataPaths.map(path => [key, ...path])),
    ];
    const homeIds = [...new Set([scope.serverId, resolveServerProfileScopeIdForIdentifier(scope.serverId)])];
    return subscribeStoragePaths([
        ...paths.map(path => ['state', 'sessions', sessionId, ...path]),
        ...homeIds.flatMap(serverId => paths.map(path => ['state', 'sessionListRowsByServerId', serverId, sessionId, ...path])),
    ], event => {
        if (event.kind !== 'state') return;
        const next = event.state.sessions[sessionId];
        const previous = event.previous.sessions[sessionId];
        const directIsAddressed = [next, previous].some(session => session && (!session.serverId
            || areServerProfileIdentifiersEquivalent(session.serverId, scope.serverId)));
        const listedChanged = homeIds.some(serverId => event.state.sessionListRowsByServerId[serverId]?.[sessionId]
            !== event.previous.sessionListRowsByServerId[serverId]?.[sessionId]);
        if (directIsAddressed || listedChanged) notify();
    });
}
