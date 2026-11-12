import { ConnectedAccountPurposeDeclarationsV1Schema } from '@happier-dev/protocol/connect/connected-account-purposes';
import { ConnectedAccountRequestAuthUsesV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedAccountPurposeDeclarationV1, PluginContributionIdentityV1, QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountRequestAuthUseV1 } from '@happier-dev/protocol';
import type { ConnectedAccountPurposeAuthorizationScope } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';


type AgentConnectedAccountPurposeProjection = Readonly<{
    identity: unknown;
    connectedAccounts: unknown;
    requestAuthUses: unknown;
    fileEnvironmentUses: unknown;
    environmentUses: unknown;
    environmentUnsetUses: unknown;
}>;

type AgentConnectedAccountFileEnvironmentUse = Readonly<{
    purpose: string;
    fileId: string;
    environmentKey: string;
}>;

type AgentConnectedAccountEnvironmentUse = Readonly<{
    purpose: string;
    environmentKey: string;
}>;

export type AgentSpawnQualifiedFileEnvironmentUse = Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionIdentityV1[];
    fileId: string;
    environmentKey: string;
}>;

export type AgentSpawnQualifiedEnvironmentUse = Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionIdentityV1[];
    environmentKey: string;
}>;

export type AgentSpawnPurposeCatalogEntry = Readonly<{
    connectedAccountRequestAuthUses?: unknown;
    connectedAccountFileEnvironmentUses?: unknown;
    connectedAccountEnvironmentUses?: unknown;
    connectedAccountEnvironmentUnsetUses?: unknown;
}>;

export type AgentSpawnPurposeContributions = Readonly<{
    agentDefinitionsById: ReadonlyMap<string, Readonly<{
        identity?: unknown;
        richDefinition?: Readonly<{
            definition: Readonly<{ connectedAccounts?: unknown }>;
        }> | null;
        catalogEntry?: AgentSpawnPurposeCatalogEntry | null;
    }>>;
}>;
/**
 * Cold manifest declaration projection used before the canonical qualified-purpose binding
 * owner resolves durable selection. It never accepts the released service-keyed selection
 * shape; callers admit that compatibility ingress only when the current catalog projects
 * a matching declared legacy Connected Service.
 */
export type AgentSpawnPurposeAuthorizationScope = ConnectedAccountPurposeAuthorizationScope
    & Pick<ConnectedAccountPurposeDeclarationV1, 'credentialKinds'>;

export type AgentSpawnQualifiedPurposeDeclarationSnapshot = Readonly<{
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    authorizedPurposes: readonly AgentSpawnPurposeAuthorizationScope[];
    fileMaterializationPurposes: readonly ConnectedAccountPurposeAuthorizationScope[];
    requestAuthUses?: readonly QualifiedConnectedAccountRequestAuthUseV1[];
    fileEnvironmentUses?: readonly AgentSpawnQualifiedFileEnvironmentUse[];
    environmentUses?: readonly AgentSpawnQualifiedEnvironmentUse[];
    environmentUnsetUses?: readonly AgentSpawnQualifiedEnvironmentUse[];
}>;

type ResolvedAgentSpawnPurposeDeclarations = Readonly<{
    consumer: PluginContributionIdentityV1;
    declarations: readonly ConnectedAccountPurposeDeclarationV1[];
    snapshot: AgentSpawnQualifiedPurposeDeclarationSnapshot;
}>;

function resolveAgentContribution(
    contributions: AgentSpawnPurposeContributions,
    agentId: string,
    acquiredCatalogEntry?: AgentSpawnPurposeCatalogEntry | null,
): AgentConnectedAccountPurposeProjection | null {
    const contribution = contributions.agentDefinitionsById.get(agentId);
    if (!contribution?.richDefinition) return null;
    const catalogEntry = acquiredCatalogEntry === undefined ? contribution.catalogEntry : acquiredCatalogEntry;
    return {
        identity: contribution.identity,
        connectedAccounts:
            contribution.richDefinition.definition.connectedAccounts,
        requestAuthUses:
            catalogEntry?.connectedAccountRequestAuthUses,
        fileEnvironmentUses:
            catalogEntry?.connectedAccountFileEnvironmentUses,
        environmentUses:
            catalogEntry?.connectedAccountEnvironmentUses,
        environmentUnsetUses:
            catalogEntry?.connectedAccountEnvironmentUnsetUses,
    };
}

function snapshotAgentConnectedAccountFileEnvironmentUses(
    value: unknown,
): readonly AgentConnectedAccountFileEnvironmentUse[] | null | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0) return null;
    const uses: AgentConnectedAccountFileEnvironmentUse[] = [];
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
        const candidate = entry as Record<string, unknown>;
        if (
            typeof candidate.purpose !== 'string'
            || candidate.purpose.length === 0
            || typeof candidate.fileId !== 'string'
            || candidate.fileId.length === 0
            || typeof candidate.environmentKey !== 'string'
            || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(candidate.environmentKey)
        ) return null;
        uses.push(Object.freeze({
            purpose: candidate.purpose,
            fileId: candidate.fileId,
            environmentKey: candidate.environmentKey,
        }));
    }
    return Object.freeze(uses);
}

function snapshotAgentConnectedAccountEnvironmentUses(
    value: unknown,
): readonly AgentConnectedAccountEnvironmentUse[] | null | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0) return null;
    const uses: AgentConnectedAccountEnvironmentUse[] = [];
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
        const candidate = entry as Record<string, unknown>;
        if (
            typeof candidate.purpose !== 'string'
            || candidate.purpose.length === 0
            || typeof candidate.environmentKey !== 'string'
            || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(candidate.environmentKey)
        ) return null;
        uses.push(Object.freeze({ purpose: candidate.purpose, environmentKey: candidate.environmentKey }));
    }
    return Object.freeze(uses);
}

export function resolveAgentSpawnPurposeDeclarations(input: Readonly<{
    agentId: string;
    contributions: AgentSpawnPurposeContributions;
    catalogEntry?: AgentSpawnPurposeCatalogEntry | null;
}>): ResolvedAgentSpawnPurposeDeclarations | null {
    const projection = resolveAgentContribution(
        input.contributions,
        input.agentId,
        input.catalogEntry,
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
    const fileEnvironmentUses = snapshotAgentConnectedAccountFileEnvironmentUses(
        projection?.fileEnvironmentUses,
    );
    if (fileEnvironmentUses === null) return null;
    const environmentUses = snapshotAgentConnectedAccountEnvironmentUses(
        projection?.environmentUses,
    );
    if (environmentUses === null) return null;
    const environmentUnsetUses = snapshotAgentConnectedAccountEnvironmentUses(
        projection?.environmentUnsetUses,
    );
    if (environmentUnsetUses === null) return null;
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
    if (fileEnvironmentUses?.some((use) => (
        declarationsByPurpose.get(use.purpose)?.materializationKinds?.includes('files') !== true
    ))) return null;
    if (environmentUses?.some((use) => (
        declarationsByPurpose.get(use.purpose)?.materializationKinds?.includes('environment') !== true
    ))) return null;
    if (environmentUnsetUses?.some((use) => !declarationsByPurpose.has(use.purpose))) return null;
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
                ...(declaration.credentialKinds ? { credentialKinds: declaration.credentialKinds } : {}),
            });
        }),
    );
    const authorizedPurposesByLocalId = new Map(
        authorizedPurposes.map((scope) => [scope.purpose.purpose, scope]),
    );
    const fileMaterializationPurposes = Object.freeze(
        declarations.data.flatMap((declaration) => {
            if (declaration.managedProviderEndpoint || declaration.materializationKinds?.includes('files') !== true) return [];
            const scope = authorizedPurposesByLocalId.get(declaration.purpose);
            return scope ? [scope] : [];
        }),
    );
    const qualifiedRequestAuthUses: readonly QualifiedConnectedAccountRequestAuthUseV1[] | null =
        requestAuthUses?.success
            ? Object.freeze(requestAuthUses.data.filter(use => !declarationsByPurpose.get(use.purpose)?.managedProviderEndpoint).map((use): QualifiedConnectedAccountRequestAuthUseV1 =>
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
    const qualifiedFileEnvironmentUses = fileEnvironmentUses === undefined
        ? null
        : Object.freeze(fileEnvironmentUses.filter(use => !declarationsByPurpose.get(use.purpose)?.managedProviderEndpoint).map((use): AgentSpawnQualifiedFileEnvironmentUse => {
            const scope = authorizedPurposesByLocalId.get(use.purpose);
            if (!scope) throw new Error('connected_account_launch_file_environment_purpose_unavailable');
            return Object.freeze({
                purpose: scope.purpose,
                serviceRefs: scope.serviceRefs,
                fileId: use.fileId,
                environmentKey: use.environmentKey,
            });
        }));
    const qualifyEnvironmentUses = (uses: readonly AgentConnectedAccountEnvironmentUse[] | undefined) => uses === undefined
        ? null
        : Object.freeze(uses.map((use): AgentSpawnQualifiedEnvironmentUse => {
            const scope = authorizedPurposesByLocalId.get(use.purpose);
            if (!scope) throw new Error('connected_account_launch_environment_purpose_unavailable');
            return Object.freeze({
                purpose: scope.purpose,
                serviceRefs: scope.serviceRefs,
                environmentKey: use.environmentKey,
            });
        }));
    const qualifiedEnvironmentUses = qualifyEnvironmentUses(environmentUses?.filter(use => !declarationsByPurpose.get(use.purpose)?.managedProviderEndpoint));
    const qualifiedEnvironmentUnsetUses = qualifyEnvironmentUses(environmentUnsetUses);
    return Object.freeze({
        consumer,
        declarations: Object.freeze([...declarations.data]),
        snapshot: Object.freeze({
            purposes: Object.freeze(authorizedPurposes.map((scope) => scope.purpose)),
            authorizedPurposes,
            fileMaterializationPurposes,
            ...(qualifiedRequestAuthUses
                ? { requestAuthUses: qualifiedRequestAuthUses }
                : {}),
            ...(qualifiedFileEnvironmentUses
                ? { fileEnvironmentUses: qualifiedFileEnvironmentUses }
                : {}),
            ...(qualifiedEnvironmentUses
                ? { environmentUses: qualifiedEnvironmentUses }
                : {}),
            ...(qualifiedEnvironmentUnsetUses
                ? { environmentUnsetUses: qualifiedEnvironmentUnsetUses }
                : {}),
        }),
    });
}

export function resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn(
    input: Readonly<{
        agentId: string;
        contributions: AgentSpawnPurposeContributions;
        catalogEntry?: AgentSpawnPurposeCatalogEntry | null;
    }>,
): AgentSpawnQualifiedPurposeDeclarationSnapshot | null {
    return resolveAgentSpawnPurposeDeclarations(input)?.snapshot ?? null;
}
