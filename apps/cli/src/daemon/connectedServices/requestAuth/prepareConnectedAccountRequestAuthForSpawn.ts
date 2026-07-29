import {
    ConnectedAccountPurposeDeclarationsV1Schema,
    ConnectedAccountRequestAuthUsesV1Schema,
    PluginContributionIdentityV1Schema,
    qualifiedPurposeKey,
    type ConnectedServiceBindingsV1,
    type QualifiedConnectedAccountPurposeBindingV1,
    type QualifiedConnectedAccountPurposeV1,
    type QualifiedConnectedAccountRequestAuthUseV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';

import type {
    ConnectedAccountRequestAuthSubject,
} from './ConnectedAccountRequestAuthService';
import type {
    ConnectedAccountRequestAuthCapabilityDescriptor,
} from './capabilityFile';
import type {
    ConnectedAccountRequestAuthSubjectRegistry,
} from './ConnectedAccountRequestAuthSubjectRegistry';
import {
    projectLegacyConnectedServiceBindingsToQualifiedPurposeBindingSnapshot,
} from './firstPartyConnectedAccountRequestAuthAdapter';

type AgentConnectedAccountPurposeProjection = Readonly<{
    identity: unknown;
    connectedAccounts: unknown;
    requestAuthUses: unknown;
}>;

export type AgentSpawnPurposeContributions = Readonly<{
    agentDefinitionsById: ReadonlyMap<string, Readonly<{
        identity?: unknown;
        richDefinition?: Readonly<{
            definition: Readonly<{ connectedAccounts?: unknown }>;
        }> | null;
        catalogEntry?: Readonly<{
            connectedAccountRequestAuthUses?: unknown;
        }> | null;
    }>>;
}>;

function resolveAgentContribution(
    contributions: AgentSpawnPurposeContributions,
    agentId: CatalogAgentId,
): AgentConnectedAccountPurposeProjection | null {
    const contribution = contributions.agentDefinitionsById.get(agentId);
    if (!contribution?.richDefinition) return null;
    return {
        identity: contribution.identity,
        connectedAccounts:
            contribution.richDefinition.definition.connectedAccounts,
        requestAuthUses:
            contribution.catalogEntry?.connectedAccountRequestAuthUses,
    };
}

/**
 * Live compatibility ingress for released Agent/session `connectedServices`. The cold manifest is
 * the sole purpose declaration owner; the released service-keyed selection is translated in
 * memory and is never persisted or written back from the qualified-purpose path.
 */
export function resolveQualifiedPurposeBindingsForAgentSpawn(input: Readonly<{
    agentId: CatalogAgentId;
    bindings: ConnectedServiceBindingsV1;
    contributions: AgentSpawnPurposeContributions;
}>): readonly QualifiedConnectedAccountPurposeBindingV1[] {
    return resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input)?.bindings
        ?? Object.freeze([]);
}

export function resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn(
    input: Readonly<{
        agentId: CatalogAgentId;
        bindings: ConnectedServiceBindingsV1;
        contributions: AgentSpawnPurposeContributions;
    }>,
): readonly QualifiedConnectedAccountPurposeBindingV1[] {
    const snapshot =
        resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input);
    if (!snapshot?.requestAuthUses?.length) return Object.freeze([]);
    const requestAuthPurposeKeys = new Set(
        snapshot.requestAuthUses.map((use) =>
            qualifiedPurposeKey(use.purpose),
        ),
    );
    return Object.freeze(snapshot.bindings.filter((binding) =>
        requestAuthPurposeKeys.has(qualifiedPurposeKey(binding.purpose))));
}

export function resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input: Readonly<{
    agentId: CatalogAgentId;
    bindings: ConnectedServiceBindingsV1;
    contributions: AgentSpawnPurposeContributions;
}>): Readonly<{
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    requestAuthUses?: readonly QualifiedConnectedAccountRequestAuthUseV1[];
}> | null {
    const projection = resolveAgentContribution(
        input.contributions,
        input.agentId,
    );
    const identity = PluginContributionIdentityV1Schema.safeParse(
        projection?.identity,
    );
    const declarations = ConnectedAccountPurposeDeclarationsV1Schema.safeParse(
        projection?.connectedAccounts,
    );
    if (!identity.success || !declarations.success) return null;
    const requestAuthUses = projection?.requestAuthUses === undefined
        ? null
        : ConnectedAccountRequestAuthUsesV1Schema.safeParse(
            projection.requestAuthUses,
        );
    if (requestAuthUses?.success === false) return null;
    const declaredPurposes = new Set(
        declarations.data.map((declaration) => declaration.purpose),
    );
    if (
        requestAuthUses?.success
        && requestAuthUses.data.some((use) => !declaredPurposes.has(use.purpose))
    ) {
        return null;
    }
    const snapshot = projectLegacyConnectedServiceBindingsToQualifiedPurposeBindingSnapshot({
        consumer: identity.data,
        declarations: declarations.data,
        bindings: input.bindings,
    });
    const qualifiedRequestAuthUses: readonly QualifiedConnectedAccountRequestAuthUseV1[] | null =
        requestAuthUses?.success
            ? Object.freeze(requestAuthUses.data.map((use): QualifiedConnectedAccountRequestAuthUseV1 =>
                Object.freeze({
                    purpose: Object.freeze({
                        consumer: Object.freeze({ ...identity.data }),
                        purpose: use.purpose,
                    }),
                    materialization: Object.freeze({
                        ...use.materialization,
                        headerNames: Object.freeze([...use.materialization.headerNames]),
                    }),
                })))
            : null;
    return {
        ...snapshot,
        ...(qualifiedRequestAuthUses
            ? { requestAuthUses: qualifiedRequestAuthUses }
            : {}),
    };
}

export async function activateConnectedAccountRequestAuthForSpawn(input: Readonly<{
    agentId: CatalogAgentId;
    materializationId: string;
    materializedRootDir: string;
    httpPort: number;
    subject: ConnectedAccountRequestAuthSubject;
    registry: Pick<
        ConnectedAccountRequestAuthSubjectRegistry,
        'activate' | 'retire'
    >;
    launchResourceScope: Pick<ProviderLaunchResourceScope, 'register'>;
}>): Promise<ConnectedAccountRequestAuthCapabilityDescriptor> {
    const descriptor = await input.registry.activate({
        subject: input.subject,
        materializedRootDir: input.materializedRootDir,
        materializationId: input.materializationId,
        httpPort: input.httpPort,
    });
    let retired = false;
    const retire = async () => {
        if (retired) return;
        retired = true;
        await input.registry.retire(descriptor);
    };
    try {
        input.launchResourceScope.register({
            onFailure: retire,
            onExit: retire,
        });
    } catch (error) {
        await retire();
        throw error;
    }
    return descriptor;
}
