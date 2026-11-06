import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ProviderModelPickerSourceKind } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import type { ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { areProviderContributionKeysEqualV1, canonicalizeProviderContributionKeyV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS,
    BUNDLED_CANONICAL_AGENT_DECLARATIONS,
} from '@/agents/registry/generatedBundledPluginEntries';

const bundledProviderDeclarations: readonly AccountProviderDeclarationV1[] = Object.freeze(Object.values(BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS));

export type ProviderDeclarationContext =
    | Readonly<{ kind: 'account' }>
    | Readonly<{ kind: 'machine'; projection: PluginProjectionV2 | null | undefined }>;

/** Capture whether declarations describe Account browsing or an exact execution Machine. */
export function providerDeclarationContext(machineId: string | null | undefined, projection: PluginProjectionV2 | null | undefined): ProviderDeclarationContext {
    return machineId ? { kind: 'machine', projection } : { kind: 'account' };
}

/** Admitted portable source facts only. Dynamic plugins need their current declaration authority. */
export function readAccountProviderDeclarations(context: ProviderDeclarationContext): readonly AccountProviderDeclarationV1[] {
    if (context.kind === 'account') return bundledProviderDeclarations;
    const projection = context.projection;
    if (!projection) return [];
    return Object.values(projection.familiesById.providers?.entriesById ?? {}).flatMap(entry =>
        entry.definition && entry.provenance ? [{ contributionKey: entry.id, definition: entry.definition, provenance: entry.provenance }] : []);
}

/** Exact declaration reads use the producer's qualified-identity index, without projecting the registry. */
export function readAccountProviderDeclaration(contributionKey: string, context: ProviderDeclarationContext): AccountProviderDeclarationV1 | null {
    if (context.kind === 'account') return bundledProviderDeclarations.find(declaration =>
        areProviderContributionKeysEqualV1(declaration.contributionKey, contributionKey)) ?? null;
    const entry = context.projection?.familiesById.providers?.entriesById[canonicalizeProviderContributionKeyV1(contributionKey)];
    const definition = entry?.definition;
    return definition && entry.provenance
        ? { contributionKey: entry.id, definition, provenance: entry.provenance }
        : null;
}

/**
 * The model-picker kind of a saved connection's source: `custom`, or its admitted declaration's kind.
 * Without an admitted declaration there is no kind, so no default is guessed from a name or count.
 */
export function readProviderConnectionPickerKind(source: ProviderConnectionV1['source'] | undefined, context: ProviderDeclarationContext): ProviderModelPickerSourceKind | undefined {
    if (source?.kind === 'custom') return 'custom';
    if (source?.kind !== 'contribution') return undefined;
    return readAccountProviderDeclaration(source.contributionKey, context)?.definition.kind;
}

/** A contribution's fallback icon token; packaged brands resolve from the plugin identity. */
export function readProviderContributionIcon(contributionKey: string | null | undefined, context: ProviderDeclarationContext): string | null {
    if (!contributionKey) return null;
    return readAccountProviderDeclaration(contributionKey, context)?.definition.icon ?? null;
}

export type AccountAgentProviderRequirements =
    | Readonly<{ kind: 'known'; requirements: AgentProviderRequirementsV1 }>
    | Readonly<{ kind: 'unknown' }>;

export type AccountAgentProviderDeclaration = Readonly<{
    agentTargetKey: string;
    name?: string;
    requirements: AgentProviderRequirementsV1;
}>;

/** Portable Agent fit facts, without loading an Agent runtime or asserting installation/readiness. */
export function readAccountAgentProviderDeclarations(context: ProviderDeclarationContext): readonly AccountAgentProviderDeclaration[] {
    if (context.kind === 'account') return Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).flatMap(declaration =>
        declaration.providerRequirements ? [{
            agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: declaration.identity }),
            ...(declaration.cli?.displayName ? { name: declaration.cli.displayName } : {}),
            requirements: declaration.providerRequirements,
        }] : []);
    return Object.values(context.projection?.agentsById ?? {}).flatMap(declaration =>
        declaration.identity && declaration.providerRequirements ? [{
            agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: declaration.identity }),
            ...(declaration.title ? { name: declaration.title } : {}),
            requirements: declaration.providerRequirements,
        }] : []);
}

/** Absence is a missing declaration, never evidence that every model is compatible. */
export function resolveAccountAgentProviderRequirements(agentTargetKey: string, context: ProviderDeclarationContext): AccountAgentProviderRequirements {
    const requirements = readAccountAgentProviderRequirements(agentTargetKey, context);
    return requirements ? { kind: 'known', requirements } : { kind: 'unknown' };
}

export function readAccountAgentProviderRequirements(agentTargetKey: string, context: ProviderDeclarationContext): AgentProviderRequirementsV1 | null {
    const projection = context.kind === 'machine' ? context.projection : null;
    if (context.kind === 'machine' && !projection) return null;
    let target: ReturnType<typeof parseBackendTargetKeyV2>;
    try { target = parseBackendTargetKeyV2(agentTargetKey); } catch { return null; }
    if (target.kind === 'agent') {
        if (target.definitionId !== undefined) return null;
        if (projection) return Object.values(projection.agentsById).find(declaration =>
            declaration.identity?.pluginId === target.identity.pluginId
            && declaration.identity.localId === target.identity.localId)?.providerRequirements ?? null;
        return Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).find(declaration =>
            declaration.identity.pluginId === target.identity.pluginId
            && declaration.identity.localId === target.identity.localId)?.providerRequirements ?? null;
    }
    if (target.configuredBackendId !== undefined || target.sourceKind === 'configured') return null;
    if (projection) return projection.agentsById[target.backendId]?.providerRequirements ?? null;
    return Object.entries(BUNDLED_CANONICAL_AGENT_DECLARATIONS).find(([routingId]) => routingId === target.backendId)
        ?.[1]?.providerRequirements ?? null;
}
