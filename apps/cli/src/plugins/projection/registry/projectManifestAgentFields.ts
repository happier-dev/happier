import type { PluginAgentContributionV2 } from '@happier-dev/protocol';
import { projectNativeAgentCliRuntimeDescriptor } from './agentCliRuntimeDescriptor';
import { resolveContributedAgentRoutingId } from './agentRoutingIdentity';
import type { ResolvedAgentContribution, ResolvedContributionProvenance, ResolvedContributionSource } from './types';

/** Shared field projection after declaration ingress; no runtime or schema admission. */
export function projectManifestAgentFields(params: Readonly<{
    definition: PluginAgentContributionV2;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    /** Exact routing identity already selected by admission (not the manifest-local id). */
    admittedAgentId?: string;
}>): ResolvedAgentContribution {
    const localId = params.definition.id;
    const agentId = params.admittedAgentId
        ?? resolveContributedAgentRoutingId({ pluginId: params.pluginId, localId, provenance: params.provenance });
    const cliMetadata = params.definition.cli ?? null;
    return Object.freeze({
        id: agentId,
        identity: Object.freeze({ pluginId: params.pluginId, localId }),
        provenance: params.provenance,
        source: params.source,
        definition: Object.freeze({ kindVersion: 1, id: agentId, ownedBackendIds: Object.freeze([]), ...(params.definition.providerRequirements ? { providerRequirements: params.definition.providerRequirements } : {}) }),
        richDefinition: Object.freeze({ provenance: params.provenance, definition: params.definition }),
        runtimeSpec: cliMetadata ? projectNativeAgentCliRuntimeDescriptor({ agentId, title: params.definition.title, cli: cliMetadata }) : null,
        cliMetadata,
        pluginId: params.pluginId,
    });
}
