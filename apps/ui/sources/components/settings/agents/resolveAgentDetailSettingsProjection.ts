import type {
    PluginContributionIdentityV1,
    PluginProjectionV2,
} from '@happier-dev/protocol';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { ExternalSessionsQualifiedAgent } from '@/components/settings/externalSessions/externalSessionsIntegrationModel';
import { BUNDLED_CANONICAL_AGENT_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { projectAccountDeclaredPluginSettingsGroups } from '@/sync/domains/plugins/settings/accountDeclaredPluginSettings';

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
    const identity = input.identity;
    if (!identity) return null;
    for (const entry of Object.values(input.pluginProjectionById ?? {})) {
        if (entry.pluginId !== identity.pluginId) continue;
        const matchingGroups = entry.editableSettingsGroups.filter((group) => (
            group.target.kind === 'agent'
            && group.target.agent.pluginId === identity.pluginId
            && group.target.agent.localId === identity.localId
        ));
        if (matchingGroups.length > 0) {
            return {
                ...entry,
                editableSettingsGroups: matchingGroups,
            };
        }
        // A present daemon row is authoritative even if it removed all groups.
        return null;
    }
    const declaration = Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).find((entry) => (
        entry?.identity.pluginId === identity.pluginId && entry.identity.localId === identity.localId
    ));
    if (!declaration) return null;
    const editableSettingsGroups = projectAccountDeclaredPluginSettingsGroups({
        pluginId: identity.pluginId,
        targetAgent: identity,
        declaration: { id: identity.pluginId, contributes: { settings: [...declaration.accountSettings] } },
    });
    if (editableSettingsGroups.length === 0) return null;
    return {
        pluginId: identity.pluginId,
        title: identity.pluginId,
        description: null,
        version: null,
        enabled: null,
        generation: null,
        generationLabel: null,
        status: null,
        provenance: null,
        diagnostics: [],
        actions: [],
        resources: [],
        editableSettingsGroups,
    };
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

    // The Agent catalog is the projection's record of which Agents it carries.
    const bound = Object.values(input.projection.agentsById).some((agent) => (
        agent.identity?.pluginId === input.identity.pluginId
        && agent.identity.localId === input.identity.localId
    ));
    if (!bound) return null;

    return {
        agent: input.identity,
        generation: input.projection.generation,
        browseAvailable: false,
    };
}
