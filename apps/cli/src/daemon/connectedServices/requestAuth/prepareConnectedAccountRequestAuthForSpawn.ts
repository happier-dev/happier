import {
    ConnectedAccountPurposeDeclarationsV1Schema,
    ConnectedAccountRequestAuthUsesV1Schema,
    PluginContributionIdentityV1Schema,
    qualifiedPurposeKey,
    type ConnectedAccountPurposeDeclarationV1,
    type ConnectedServiceBindingsV1,
    type PluginContributionIdentityV1,
    type QualifiedConnectedAccountPurposeBindingV1,
    type QualifiedConnectedAccountPurposeV1,
    type QualifiedConnectedAccountRequestAuthUseV1,
} from '@happier-dev/protocol';

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
import type {
    ConnectedAccountPurposeAuthorizationScope,
} from '../purposeBindings/ConnectedAccountPurposeBindingOwner';

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

export type AgentSpawnQualifiedPurposeBindingSnapshot = Readonly<{
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    requestAuthUses?: readonly QualifiedConnectedAccountRequestAuthUseV1[];
}>;

/**
 * Cold manifest declaration projection used before the canonical qualified-purpose binding
 * owner resolves durable selection. It never accepts the released service-keyed selection
 * shape; callers admit that compatibility ingress only when the current catalog projects
 * a matching declared legacy Connected Service.
 */
export type AgentSpawnQualifiedPurposeDeclarationSnapshot = Readonly<{
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    authorizedPurposes: readonly ConnectedAccountPurposeAuthorizationScope[];
    requestAuthUses?: readonly QualifiedConnectedAccountRequestAuthUseV1[];
}>;

type ResolvedAgentSpawnPurposeDeclarations = Readonly<{
    consumer: PluginContributionIdentityV1;
    declarations: readonly ConnectedAccountPurposeDeclarationV1[];
    snapshot: AgentSpawnQualifiedPurposeDeclarationSnapshot;
}>;

function resolveAgentContribution(
    contributions: AgentSpawnPurposeContributions,
    agentId: string,
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

function resolveAgentSpawnPurposeDeclarations(input: Readonly<{
    agentId: string;
    contributions: AgentSpawnPurposeContributions;
}>): ResolvedAgentSpawnPurposeDeclarations | null {
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
    const declarationsByPurpose = new Map(
        declarations.data.map((declaration) => [
            declaration.purpose,
            declaration,
        ]),
    );
    if (
        requestAuthUses?.success
        && requestAuthUses.data.some((use) => (
            declarationsByPurpose
                .get(use.purpose)
                ?.materializationKinds
                ?.includes(use.materialization.kind)
            !== true
        ))
    ) {
        return null;
    }
    const consumer = Object.freeze({ ...identity.data });
    const authorizedPurposes = Object.freeze(
        declarations.data.map((declaration) => {
            const purpose = Object.freeze({
                consumer,
                purpose: declaration.purpose,
            });
            const service = Object.freeze(PluginContributionIdentityV1Schema.parse(
                typeof declaration.service === 'string'
                    ? {
                        pluginId: consumer.pluginId,
                        localId: declaration.service,
                    }
                    : declaration.service,
            ));
            return Object.freeze({
                purpose,
                serviceRefs: Object.freeze([service]),
            });
        }),
    );
    const qualifiedRequestAuthUses: readonly QualifiedConnectedAccountRequestAuthUseV1[] | null =
        requestAuthUses?.success
            ? Object.freeze(requestAuthUses.data.map((use): QualifiedConnectedAccountRequestAuthUseV1 =>
                Object.freeze({
                    purpose: Object.freeze({
                        consumer,
                        purpose: use.purpose,
                    }),
                    materialization: Object.freeze({
                        ...use.materialization,
                        headerNames: Object.freeze([...use.materialization.headerNames]),
                    }),
                })))
            : null;
    return Object.freeze({
        consumer,
        declarations: Object.freeze([...declarations.data]),
        snapshot: Object.freeze({
            purposes: Object.freeze(authorizedPurposes.map((scope) => scope.purpose)),
            authorizedPurposes,
            ...(qualifiedRequestAuthUses
                ? { requestAuthUses: qualifiedRequestAuthUses }
                : {}),
        }),
    });
}

export function resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn(
    input: Readonly<{
        agentId: string;
        contributions: AgentSpawnPurposeContributions;
    }>,
): AgentSpawnQualifiedPurposeDeclarationSnapshot | null {
    return resolveAgentSpawnPurposeDeclarations(input)?.snapshot ?? null;
}

/**
 * Live compatibility ingress for released Agent/session `connectedServices`. The cold manifest is
 * the sole purpose declaration owner; the released service-keyed selection is translated in
 * memory and is never persisted or written back from the qualified-purpose path.
 */
export function resolveQualifiedPurposeBindingsForAgentSpawn(input: Readonly<{
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
    contributions: AgentSpawnPurposeContributions;
}>): readonly QualifiedConnectedAccountPurposeBindingV1[] {
    return resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input)?.bindings
        ?? Object.freeze([]);
}

export function resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn(
    input: Readonly<{
        agentId: string;
        bindings: ConnectedServiceBindingsV1;
        contributions: AgentSpawnPurposeContributions;
    }>,
): readonly QualifiedConnectedAccountPurposeBindingV1[] {
    const snapshot =
        resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input);
    return resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(snapshot);
}

export function resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(
    snapshot: AgentSpawnQualifiedPurposeBindingSnapshot | null,
): readonly QualifiedConnectedAccountPurposeBindingV1[] {
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
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
    contributions: AgentSpawnPurposeContributions;
}>): AgentSpawnQualifiedPurposeBindingSnapshot | null {
    const declarations = resolveAgentSpawnPurposeDeclarations(input);
    if (!declarations) return null;
    const snapshot = projectLegacyConnectedServiceBindingsToQualifiedPurposeBindingSnapshot({
        consumer: declarations.consumer,
        declarations: declarations.declarations,
        bindings: input.bindings,
    });
    return {
        ...snapshot,
        ...(declarations.snapshot.requestAuthUses
            ? { requestAuthUses: declarations.snapshot.requestAuthUses }
            : {}),
    };
}

export async function activateConnectedAccountRequestAuthForSpawn(input: Readonly<{
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
