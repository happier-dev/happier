import { getAllAgentDefinitionContracts } from '@happier-dev/agents/definitions';

import { projectAgentCliSessionCommandCatalogEntry } from '../agentCatalogEntryHooks';
import type {
    ResolvedAgentContribution,
    ResolvedCatalogEntry,
} from '../types';
import { indexAgentBindings, manifestAgentKey, projectBuiltInAgentFields, type BundledAgentRegistrationBinding } from './agentIdentity';
export type { BundledAgentRegistrationBinding } from './agentIdentity';

function indexManifestAgents(
    contributions: readonly ResolvedAgentContribution[],
): ReadonlyMap<string, ResolvedAgentContribution> {
    const byAgentId = new Map<string, ResolvedAgentContribution>();
    for (const contribution of contributions) {
        if (byAgentId.has(contribution.id)) {
            throw new Error(`Duplicate bundled manifest agent '${contribution.id}'`);
        }
        byAgentId.set(contribution.id, contribution);
    }
    return byAgentId;
}

function indexManifestAgentsByIdentity(
    contributions: readonly ResolvedAgentContribution[],
): ReadonlyMap<string, ResolvedAgentContribution> {
    const byIdentity = new Map<string, ResolvedAgentContribution>();
    for (const contribution of contributions) {
        const pluginId = contribution.identity?.pluginId ?? contribution.pluginId;
        const localId = contribution.identity?.localId ?? contribution.id;
        if (!pluginId) continue;
        const key = manifestAgentKey(pluginId, localId);
        if (byIdentity.has(key)) {
            throw new Error(`Duplicate bundled manifest agent identity '${pluginId}/${localId}'`);
        }
        byIdentity.set(key, contribution);
    }
    return byIdentity;
}

export function projectBuiltInAgents(params: Readonly<{
    manifestAgents: readonly ResolvedAgentContribution[];
    registrationBindings: readonly BundledAgentRegistrationBinding[];
}>): readonly ResolvedAgentContribution[] {
    indexManifestAgents(params.manifestAgents);
    indexManifestAgentsByIdentity(params.manifestAgents);
    const registrationBindings = indexAgentBindings(params.registrationBindings);
    const compatibilityDefinitionsById = new Map(
        getAllAgentDefinitionContracts().map((definition) => [definition.id, definition]),
    );
    const projectedIds = new Set<string>();
    const projected = params.manifestAgents.map((manifestContribution): ResolvedAgentContribution => {
        const manifestIdentity = manifestContribution.identity
            ?? (manifestContribution.pluginId
                ? { pluginId: manifestContribution.pluginId, localId: manifestContribution.id }
                : null);
        const registration = manifestIdentity
            ? registrationBindings.byIdentity.get(manifestAgentKey(
                manifestIdentity.pluginId,
                manifestIdentity.localId,
            ))
            : undefined;
        const canonicalAgentId = registration?.implementationOwnerId ?? manifestContribution.id;
        if (projectedIds.has(canonicalAgentId)) {
            throw new Error(`Duplicate bundled canonical agent '${canonicalAgentId}'`);
        }
        projectedIds.add(canonicalAgentId);
        if (!manifestContribution.runtimeSpec
            && (manifestContribution.cliMetadata || manifestContribution.richDefinition?.definition.cli)) {
            throw new Error(`Missing bundled manifest CLI metadata for agent '${canonicalAgentId}'`);
        }
        const fields = projectBuiltInAgentFields(manifestContribution, canonicalAgentId);
        if (!manifestContribution.catalogEntry) {
            throw new Error(`Missing bundled manifest catalog projection for agent '${canonicalAgentId}'`);
        }
        const catalogEntry: ResolvedCatalogEntry = Object.freeze({
            ...manifestContribution.catalogEntry,
            id: canonicalAgentId,
            // Host-owned canonical identity for the bundled implementation.
            // CLI and vendor-resume facts remain exactly as the public manifest
            // projected them. The generic command owner adds behavior only.
            ...projectAgentCliSessionCommandCatalogEntry({ agentId: canonicalAgentId }),
        });
        const providerRequirements = manifestContribution.richDefinition?.definition.providerRequirements;
        const compatibilityDefinition = compatibilityDefinitionsById.get(canonicalAgentId);
        return Object.freeze({
            ...fields,
            definition: Object.freeze({
                ...(compatibilityDefinition ?? manifestContribution.definition),
                id: canonicalAgentId,
                ...(providerRequirements ? { providerRequirements } : {}),
            }),
            catalogEntry,
        } satisfies ResolvedAgentContribution);
    });
    // Admission owns missing/invalid optional manifests. An executable binding
    // alone cannot resurrect an excluded Agent or make healthy peers fatal.
    return Object.freeze(projected);
}
