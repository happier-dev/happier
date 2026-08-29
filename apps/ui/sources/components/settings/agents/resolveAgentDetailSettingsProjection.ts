import type {
    PluginContributionIdentityV1,
    PluginProjectionV2,
} from '@happier-dev/protocol';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { ExternalSessionsQualifiedAgent } from '@/components/settings/externalSessions/externalSessionsIntegrationModel';

/**
 * The one exact Agent identity the Agent-detail screen addresses.
 *
 * A qualified route names it outright; otherwise the resolved catalog
 * projection supplies it. Every settings and binding comparison on the screen
 * consumes this identity and compares pluginId+localId: a localId-only match
 * collides whenever two installed plugins declare the same local Agent id.
 */
export function resolveAgentDetailQualifiedIdentity(input: Readonly<{
    routeQualifiedAgent: PluginContributionIdentityV1 | null;
    projectionIdentity: PluginContributionIdentityV1 | null;
}>): PluginContributionIdentityV1 | null {
    return input.routeQualifiedAgent ?? input.projectionIdentity ?? null;
}

/**
 * The plugin's settings groups for exactly this Agent identity. Entries whose
 * agent-targeted groups match another plugin's same-localId Agent never win.
 */
export function resolveAgentDetailPluginSettingsProjection(input: Readonly<{
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>> | null | undefined;
    identity: PluginContributionIdentityV1 | null;
}>): PluginProjectionEntry | null {
    if (!input.identity) return null;
    for (const entry of Object.values(input.pluginProjectionById ?? {})) {
        if (entry.pluginId !== input.identity.pluginId) continue;
        const matchingGroups = entry.editableSettingsGroups.filter((group) => (
            group.target.kind === 'agent'
            && group.target.agent.pluginId === input.identity.pluginId
            && group.target.agent.localId === input.identity.localId
        ));
        if (matchingGroups.length > 0) {
            return {
                ...entry,
                editableSettingsGroups: matchingGroups,
            };
        }
    }
    return null;
}

/**
 * The Agent's External Sessions binding, addressed by the exact qualified
 * identity. The live daemon-owned binding wins; otherwise the contribution
 * scan is a qualified fact check, never a localId guess.
 */
export function resolveAgentDetailExternalSessionsBinding(input: Readonly<{
    projection: PluginProjectionV2 | null | undefined;
    agentId: string;
    identity: ExternalSessionsQualifiedAgent;
}>): Readonly<{
    agent: ExternalSessionsQualifiedAgent;
    generation: number;
    browseAvailable: boolean;
}> | null {
    if (!input.projection) return null;

    const externalSessions = input.projection.agentsById[input.agentId]?.externalSessions;
    if (
        externalSessions?.generation === input.projection.generation
        && externalSessions.agent.pluginId === input.identity.pluginId
        && externalSessions.agent.localId === input.identity.localId
    ) {
        return {
            agent: externalSessions.agent,
            generation: externalSessions.generation,
            browseAvailable: true,
        };
    }

    const bound = input.projection.contributionIntrospection?.contributions.some((record) => (
        record.progression.merged
        && record.projection.state === 'projected'
        && record.contribution.kind === 'localId'
        && record.contribution.family === 'agents'
        && record.contribution.pluginId === input.identity.pluginId
        && record.contribution.localId === input.identity.localId
    ));
    if (!bound) return null;

    return {
        agent: input.identity,
        generation: input.projection.generation,
        browseAvailable: false,
    };
}
