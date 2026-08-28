import { getAllAgentDefinitionContracts } from '@happier-dev/agents/definitions';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';

import { projectAgentCliSessionCommandCatalogEntry } from '../agentCatalogEntryHooks';
import type {
    ResolvedAgentContribution,
    ResolvedCatalogEntry,
} from '../types';

export type BundledAgentRegistrationBinding = Readonly<{
    identity: PluginContributionIdentityV1;
    implementationOwnerId: string;
    registrationFamily: string;
}>;

function indexAgentBindings(
    bindings: readonly BundledAgentRegistrationBinding[],
): Readonly<{
    byIdentity: ReadonlyMap<string, BundledAgentRegistrationBinding>;
    byImplementationOwnerId: ReadonlyMap<string, BundledAgentRegistrationBinding>;
}> {
    const byIdentity = new Map<string, BundledAgentRegistrationBinding>();
    const byAgentId = new Map<string, BundledAgentRegistrationBinding>();
    for (const binding of bindings) {
        if (binding.registrationFamily !== 'agents') continue;
        if (byAgentId.has(binding.implementationOwnerId)) {
            throw new Error(`Duplicate bundled agent implementation binding '${binding.implementationOwnerId}'`);
        }
        const identity = manifestAgentKey(binding.identity.pluginId, binding.identity.localId);
        if (byIdentity.has(identity)) {
            throw new Error(`Duplicate bundled agent registration identity '${binding.identity.pluginId}/${binding.identity.localId}'`);
        }
        byAgentId.set(binding.implementationOwnerId, binding);
        byIdentity.set(identity, binding);
    }
    return Object.freeze({
        byIdentity,
        byImplementationOwnerId: byAgentId,
    });
}

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

function manifestAgentKey(pluginId: string, localId: string): string {
    return `${pluginId}\u0000${localId}`;
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
    const manifestAgentsByIdentity = indexManifestAgentsByIdentity(params.manifestAgents);
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
        if (!manifestContribution.runtimeSpec) {
            throw new Error(`Missing bundled manifest CLI metadata for agent '${canonicalAgentId}'`);
        }
        const runtimeSpec = Object.freeze({
            ...manifestContribution.runtimeSpec,
            id: canonicalAgentId,
        });
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
        const richDefinition = manifestContribution.richDefinition
            ? Object.freeze({
                ...manifestContribution.richDefinition,
                definition: Object.freeze({
                    ...manifestContribution.richDefinition.definition,
                    id: canonicalAgentId,
                }),
            })
            : undefined;
        return Object.freeze({
            ...manifestContribution,
            id: canonicalAgentId,
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: Object.freeze({
                ...(compatibilityDefinition ?? manifestContribution.definition),
                id: canonicalAgentId,
                ...(providerRequirements ? { providerRequirements } : {}),
            }),
            richDefinition,
            runtimeSpec,
            catalogEntry,
        } satisfies ResolvedAgentContribution);
    });
    for (const binding of registrationBindings.byImplementationOwnerId.values()) {
        if (!manifestAgentsByIdentity.has(manifestAgentKey(
            binding.identity.pluginId,
            binding.identity.localId,
        ))) {
            throw new Error(`Missing bundled manifest for agent '${binding.implementationOwnerId}'`);
        }
    }
    return Object.freeze(projected);
}
