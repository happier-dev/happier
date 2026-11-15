import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ProviderModelPickerSourceKind } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import type { ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { areProviderContributionKeysEqualV1, canonicalizeProviderContributionKeyV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveProjectedConnectedAccountServiceKeys } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import {
    readProjectedAgentDeclarationV1,
    readProjectedProviderDeclarationsV1,
    resolveAgentTeamCredentialDemandV1,
    resolveAgentTeamCredentialBrokeredUseV1,
    type AgentTeamCredentialDemandV1,
    type AgentTeamCredentialBrokeredUseV1,
} from '@happier-dev/protocol/teams';
import { getBundledAgentDeclaration } from '@/agents/registry/registryCore';
import {
    BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS,
    BUNDLED_CANONICAL_AGENT_DECLARATIONS,
    type BundledAgentDeclaration,
} from '@/agents/registry/generatedBundledPluginEntries';

const bundledProviderDeclarations: readonly AccountProviderDeclarationV1[] = Object.freeze(Object.values(BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS));

export type ProviderDeclarationContext =
    | Readonly<{ kind: 'account'; projection?: PluginProjectionV2 | null }>
    | Readonly<{ kind: 'machine'; projection: PluginProjectionV2 | null | undefined }>;

/** The Machine projection sections every reader of a machine declaration context reads. */
export const PROVIDER_DECLARATION_CONTEXT_SECTIONS = ['agentsById', 'familiesById.providers'] as const;

/** Capture whether declarations describe Account browsing or an exact execution Machine. */

export function providerDeclarationContext(machineId: string | null | undefined, projection: PluginProjectionV2 | null | undefined): ProviderDeclarationContext {
    return machineId ? { kind: 'machine', projection } : { kind: 'account' };
}

/** Admitted portable source facts only. Dynamic plugins need their current declaration authority. */
export function readAccountProviderDeclarations(context: ProviderDeclarationContext): readonly AccountProviderDeclarationV1[] {
    const projection = context.projection;
    if (!projection) return context.kind === 'account' ? bundledProviderDeclarations : [];
    const projected = readProjectedProviderDeclarationsV1(projection);
    if (context.kind === 'machine') return projected;
    // Account facts remain available without an execution Machine. An admitted
    // projection supplements dynamic Providers and supplies its current definitions.
    const declarations = new Map(bundledProviderDeclarations.map(declaration =>
        [canonicalizeProviderContributionKeyV1(declaration.contributionKey), declaration]));
    for (const declaration of projected) declarations.set(canonicalizeProviderContributionKeyV1(declaration.contributionKey), declaration);
    return [...declarations.values()];
}

/** Exact declaration reads use the producer's qualified-identity index, without projecting the registry. */
export function readAccountProviderDeclaration(contributionKey: string, context: ProviderDeclarationContext): AccountProviderDeclarationV1 | null {
    const entry = context.projection?.familiesById.providers?.entriesById[canonicalizeProviderContributionKeyV1(contributionKey)];
    const definition = entry?.definition;
    return definition && entry.provenance
        ? { contributionKey: entry.id, definition, provenance: entry.provenance }
        : context.kind === 'account' ? bundledProviderDeclarations.find(declaration =>
            areProviderContributionKeysEqualV1(declaration.contributionKey, contributionKey)) ?? null : null;
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
    if (context.kind === 'account' && !context.projection) return Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).flatMap(declaration =>
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

type ExactAccountAgentDeclaration =
    | Readonly<{ kind: 'bundled'; declaration: BundledAgentDeclaration }>
    | Readonly<{ kind: 'projected'; declaration: PluginProjectionV2['agentsById'][string] }>;

function readExactAccountAgentDeclaration(agentTargetKey: string, context: ProviderDeclarationContext): ExactAccountAgentDeclaration | null {
    const projection = context.projection;
    if (context.kind === 'machine' && !projection) return null;
    if (projection) {
        const declaration = readProjectedAgentDeclarationV1(projection, agentTargetKey);
        return declaration ? { kind: 'projected', declaration } : null;
    }
    let target: ReturnType<typeof parseBackendTargetKeyV2>;
    try { target = parseBackendTargetKeyV2(agentTargetKey); } catch { return null; }
    if (target.kind === 'agent') {
        if (target.definitionId !== undefined) return null;
        const declaration = Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).find(declaration =>
            declaration.identity.pluginId === target.identity.pluginId
            && declaration.identity.localId === target.identity.localId);
        return declaration ? { kind: 'bundled', declaration } : null;
    }
    if (target.configuredBackendId !== undefined || target.sourceKind === 'configured') return null;
    const declaration = getBundledAgentDeclaration(target.backendId);
    return declaration ? { kind: 'bundled', declaration } : null;
}

export function readAccountAgentProviderRequirements(agentTargetKey: string, context: ProviderDeclarationContext): AgentProviderRequirementsV1 | null {
    return readExactAccountAgentDeclaration(agentTargetKey, context)?.declaration.providerRequirements ?? null;
}

/** The same declaration-owned fact used by Team credential application admission. */
export function readAccountAgentBrokeredUse(agentTargetKey: string, context: ProviderDeclarationContext): AgentTeamCredentialBrokeredUseV1 {
    const resolved = readExactAccountAgentDeclaration(agentTargetKey, context);
    return resolveAgentTeamCredentialBrokeredUseV1({ declarationResolved: resolved !== null,
        requirements: resolved?.declaration.providerRequirements });
}

export function readAccountAgentQualifiedConnectedAccounts(agentTargetKey: string, context: ProviderDeclarationContext) {
    const resolved = readExactAccountAgentDeclaration(agentTargetKey, context);
    if (!resolved) return null;
    return resolved.kind === 'bundled'
        ? resolved.declaration.connectedAccounts.map(purpose => ({
            ...purpose,
            service: qualifyPluginContributionReferenceV1(purpose.service, resolved.declaration.identity.pluginId),
        })) : resolved.declaration.connectedAccounts ?? [];
}

/** Selected Account sources declared by this exact Agent; the catalog owner decides usable membership. */
export function readAccountAgentCatalogConnectedServices(agentTargetKey: string, context: ProviderDeclarationContext,
    bindings: ConnectedServiceBindingsV2): ConnectedServiceBindingsV2 | null {
    const bindingsByServiceId: ConnectedServiceBindingsV2['bindingsByServiceId'] = {};
    for (const purpose of readAccountAgentQualifiedConnectedAccounts(agentTargetKey, context) ?? []) {
        const serviceKey = buildQualifiedPluginContributionKey(purpose.service);
        const binding = bindings.bindingsByServiceId[serviceKey];
        if (binding?.source === 'connected') bindingsByServiceId[serviceKey] = binding;
    }
    return Object.keys(bindingsByServiceId).length ? { v: 2, bindingsByServiceId } : null;
}

/** Which Team credential applications and services an Agent can use here, through the protocol owner. */
export function resolveAccountAgentTeamCredentialDemand(agentTargetKey: string, context: ProviderDeclarationContext): AgentTeamCredentialDemandV1 {
    return resolveAgentTeamCredentialDemandV1({ agentTargetKey,
        requirements: readAccountAgentProviderRequirements(agentTargetKey, context),
        connectedAccounts: readAccountAgentQualifiedConnectedAccounts(agentTargetKey, context),
        providers: readAccountProviderDeclarations(context) });
}

/** Null retains diagnosis when the exact Agent's connected-account declaration is unresolved. */
export function readAccountAgentConnectedAccountServiceKeys(
    agentTargetKey: string,
    context: ProviderDeclarationContext,
): ReturnType<typeof resolveProjectedConnectedAccountServiceKeys> | null {
    const connectedAccounts = readAccountAgentQualifiedConnectedAccounts(agentTargetKey, context);
    return connectedAccounts ? resolveProjectedConnectedAccountServiceKeys(connectedAccounts) : null;
}
