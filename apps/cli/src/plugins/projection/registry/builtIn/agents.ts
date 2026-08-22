import {
    getAllAgentDefinitionContracts,
    getAllAgentCatalogDefinitions,
} from '@happier-dev/agents';
import type { AgentCatalogDefinition } from '@happier-dev/agents';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';

import { createAgentRuntimeCatalogEntryHooks } from '../agentCatalogEntryHooks';
import type {
    ResolvedAgentContribution,
    ResolvedCatalogEntry,
} from '../types';

export type BundledAgentImplementationBinding = Readonly<{
    identity: PluginContributionIdentityV1;
    implementationOwnerId: string;
    registrationFamily: string;
    implementation: unknown;
}>;

type CatalogHookFactory = () => Partial<ResolvedCatalogEntry>;

function readCatalogHookFactory(binding: BundledAgentImplementationBinding): CatalogHookFactory {
    if (binding.registrationFamily !== 'agents' || typeof binding.implementation !== 'function') {
        throw new Error(
            `Invalid bundled implementation binding '${binding.identity.pluginId}/${binding.identity.localId}'`,
        );
    }
    return binding.implementation as CatalogHookFactory;
}

function indexAgentBindings(
    bindings: readonly BundledAgentImplementationBinding[],
): ReadonlyMap<string, Readonly<{
    binding: BundledAgentImplementationBinding;
    createHooks: CatalogHookFactory;
}>> {
    const byAgentId = new Map<string, Readonly<{
        binding: BundledAgentImplementationBinding;
        createHooks: CatalogHookFactory;
    }>>();
    for (const binding of bindings) {
        if (binding.registrationFamily !== 'agents') continue;
        if (byAgentId.has(binding.implementationOwnerId)) {
            throw new Error(`Duplicate bundled agent implementation binding '${binding.implementationOwnerId}'`);
        }
        byAgentId.set(binding.implementationOwnerId, {
            binding,
            createHooks: readCatalogHookFactory(binding),
        });
    }
    return byAgentId;
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
        if (!contribution.pluginId) continue;
        const key = manifestAgentKey(contribution.pluginId, contribution.id);
        if (byIdentity.has(key)) {
            throw new Error(`Duplicate bundled manifest agent identity '${contribution.pluginId}/${contribution.id}'`);
        }
        byIdentity.set(key, contribution);
    }
    return byIdentity;
}

export function projectBuiltInAgents(params: Readonly<{
    manifestAgents: readonly ResolvedAgentContribution[];
    implementationBindings: readonly BundledAgentImplementationBinding[];
}>): readonly ResolvedAgentContribution[] {
    const manifestAgentsById = indexManifestAgents(params.manifestAgents);
    const manifestAgentsByIdentity = indexManifestAgentsByIdentity(params.manifestAgents);
    const implementationByAgentId = indexAgentBindings(params.implementationBindings);
    const catalogDefinitionsById: ReadonlyMap<string, AgentCatalogDefinition> = new Map(
        getAllAgentCatalogDefinitions().map((definition) => [definition.id, definition] as const),
    );

    return Object.freeze(getAllAgentDefinitionContracts().map((definition): ResolvedAgentContribution => {
        const implementation = implementationByAgentId.get(definition.id);
        const manifestContribution = implementation
            ? manifestAgentsByIdentity.get(manifestAgentKey(
                implementation.binding.identity.pluginId,
                implementation.binding.identity.localId,
            ))
            : manifestAgentsById.get(definition.id);
        const catalogDefinition = catalogDefinitionsById.get(definition.id);
        if (!manifestContribution || !catalogDefinition) {
            throw new Error(`Missing bundled manifest or catalog definition for agent '${definition.id}'`);
        }
        if (!manifestContribution.runtimeSpec) {
            throw new Error(`Missing bundled manifest CLI metadata for agent '${definition.id}'`);
        }
        const runtimeSpec = Object.freeze({
            ...manifestContribution.runtimeSpec,
            id: definition.id,
        });
        const catalogEntry: ResolvedCatalogEntry = Object.freeze({
            ...(manifestContribution.catalogEntry ?? {}),
            id: definition.id,
            cliSubcommand: catalogDefinition.core.cliSubcommand,
            // Host-owned canonical identity for `happy <agent>`: the bundled
            // manifest may declare the Agent under a differently cased local id,
            // and the review Agents declare no session capability at all, so the
            // manifest projection alone would drop or mis-key their command. The
            // command itself is still built by the one catalog-entry hook owner,
            // and a plugin runtime contribution below still overrides it.
            ...createAgentRuntimeCatalogEntryHooks({
                agentId: definition.id,
                packageName: manifestContribution.pluginId ?? definition.id,
                contribution: { cliSessionCommand: {} },
            })(),
            vendorResumeSupport: catalogDefinition.core.resume.vendorResume,
            ...(implementation ? implementation.createHooks() : {}),
        });
        const providerRequirements = manifestContribution.richDefinition?.definition.providerRequirements;
        const richDefinition = manifestContribution.richDefinition
            ? Object.freeze({
                ...manifestContribution.richDefinition,
                definition: Object.freeze({
                    ...manifestContribution.richDefinition.definition,
                    id: definition.id,
                }),
            })
            : undefined;
        return Object.freeze({
            ...manifestContribution,
            id: definition.id,
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: Object.freeze({
                ...definition,
                ...(providerRequirements ? { providerRequirements } : {}),
            }),
            richDefinition,
            runtimeSpec,
            catalogEntry,
        } satisfies ResolvedAgentContribution);
    }));
}
