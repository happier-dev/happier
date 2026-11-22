import { ConnectedAccountPurposeDeclarationsV1Schema } from '@happier-dev/protocol/connect/connected-account-purposes';
import { ConnectedAccountRequestAuthUsesV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { buildQualifiedPluginContributionKey, PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServiceBindingsV2, ConnectedAccountPurposeDeclarationV1, PluginContributionIdentityV1, QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountRequestAuthUseV1 } from '@happier-dev/protocol';
import type { ConnectedAccountPurposeAuthorizationScope } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { PluginSystemToolContributionV1 } from '@happier-dev/protocol/plugins/contributions/system-tools';
import { PluginError } from '@happier-dev/plugin-sdk/errors';


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
    gitCredentialHelper?: Readonly<{ host: string; executable: string; args: readonly string[] }>;
}>;

export type AgentSpawnPurposeCatalogEntry = Readonly<{
    connectedAccountRequestAuthUses?: unknown;
    connectedAccountFileEnvironmentUses?: unknown;
    connectedAccountEnvironmentUses?: unknown;
    connectedAccountEnvironmentUnsetUses?: unknown;
}>;

export type AgentSpawnPurposeContributions = Readonly<{
    systemTools?: readonly Readonly<{ pluginId?: string; definition: PluginSystemToolContributionV1 }>[];
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
    brokeredUnavailableCode?: string;
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
            if (declaration.materializationKinds?.includes('files') !== true) return [];
            const scope = authorizedPurposesByLocalId.get(declaration.purpose);
            return scope ? [scope] : [];
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
    const qualifiedFileEnvironmentUses = fileEnvironmentUses === undefined
        ? null
        : Object.freeze(fileEnvironmentUses.map((use): AgentSpawnQualifiedFileEnvironmentUse => {
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
    const qualifiedEnvironmentUses = qualifyEnvironmentUses(environmentUses);
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

/** Cold catalogs retain all tool choices. A process launch binding snapshot includes
 * optional machine tools only when their service has an explicit connected selection;
 * required Agent purposes remain complete, including unbound native choices. */
export function resolveLaunchPurposeDeclarations(input: Parameters<typeof resolveAgentSpawnPurposeDeclarations>[0] & Readonly<{
    bindings?: ConnectedServiceBindingsV2;
    purposeDemand?: 'agent';
}>): readonly ResolvedAgentSpawnPurposeDeclarations[] {
    const agent = resolveAgentSpawnPurposeDeclarations(input);
    if (!agent) return [];
    if (input.purposeDemand === 'agent') return [agent];
    const declaredTools = resolveSystemToolLaunchPurposeDeclarations(input.contributions);
    const tools = input.bindings ? selectBoundSystemToolLaunchPurposeDeclarations(declaredTools, input.bindings) : declaredTools;
    return [agent, ...tools];
}

/** Apply the launch owner's explicit tool selection rule to retained Session
 * selections as well as a new Agent launch; native/unselected tools demand no material. */
export function selectBoundSystemToolLaunchPurposeDeclarations(
    declarations: readonly ResolvedAgentSpawnPurposeDeclarations[],
    bindings: ConnectedServiceBindingsV2,
): readonly ResolvedAgentSpawnPurposeDeclarations[] {
    return declarations.filter(declaration => declaration.snapshot.authorizedPurposes.some(scope => scope.serviceRefs.some(service => {
        const selection = bindings.bindingsByServiceId[buildQualifiedPluginContributionKey(service)];
        return selection !== undefined && selection.source !== 'native';
    })));
}

/** The same tool purposes also apply to admitted processes with no Agent. */
export function resolveSystemToolLaunchPurposeDeclarations(contributions: Pick<AgentSpawnPurposeContributions, 'systemTools'>): readonly ResolvedAgentSpawnPurposeDeclarations[] {
    return (contributions.systemTools ?? []).flatMap<ResolvedAgentSpawnPurposeDeclarations>(({ pluginId, definition }) => {
        const launch = definition.connectedAccountLaunch;
        if (!pluginId || !launch) return [];
        const consumer = { pluginId, localId: definition.id };
        const purpose = { consumer, purpose: launch.purpose };
        const service = typeof launch.service === 'string' ? { pluginId, localId: launch.service } : launch.service;
        const scope = { purpose, serviceRefs: [service] };
        return [{ consumer, declarations: [{ purpose: launch.purpose, service: launch.service, materializationKinds: ['environment'] }],
            ...(launch.brokeredUnavailableCode ? { brokeredUnavailableCode: launch.brokeredUnavailableCode } : {}),
            snapshot: { purposes: [purpose], authorizedPurposes: [scope], fileMaterializationPurposes: [],
                environmentUses: [{ ...scope, environmentKey: launch.environmentKey,
                    // Bundled gh declares one system command on the admitted
                    // process PATH, shared with native tool lookup.
                    ...(launch.gitCredentialHelper ? { gitCredentialHelper: { ...launch.gitCredentialHelper,
                        executable: definition.executableNames[0]! } } : {}) }],
                environmentUnsetUses: (launch.unsetEnvironmentKeys ?? []).map(environmentKey => ({ ...scope, environmentKey })),
            } }];
    });
}

/** Both compatibility Session ingress and qualified finite admissions consume
 * the declared tool's delivery contract; callers supply the selected fact. */
export function assertLaunchPurposeDeliverySupported(input: Readonly<{
    declarations: readonly ResolvedAgentSpawnPurposeDeclarations[];
    readDeliveryMode(scope: AgentSpawnPurposeAuthorizationScope): 'direct' | 'brokered' | null;
}>): void {
    for (const declaration of input.declarations) {
        if (!declaration.brokeredUnavailableCode) continue;
        for (const scope of declaration.snapshot.authorizedPurposes) {
            if (input.readDeliveryMode(scope) !== 'brokered') continue;
            throw new PluginError({ code: declaration.brokeredUnavailableCode,
                message: 'This machine CLI requires direct Connected Account delivery.', retryable: false,
                details: { reason: declaration.brokeredUnavailableCode,
                    failureCause: { code: 'credential_unavailable', phase: 'authentication', failureReason: 'authentication_required', retryable: false } } });
        }
    }
}

export function mergeLaunchPurposeDeclarationSnapshots(snapshots: readonly AgentSpawnQualifiedPurposeDeclarationSnapshot[]): AgentSpawnQualifiedPurposeDeclarationSnapshot {
    return {
        purposes: snapshots.flatMap(snapshot => snapshot.purposes),
        authorizedPurposes: snapshots.flatMap(snapshot => snapshot.authorizedPurposes),
        fileMaterializationPurposes: snapshots.flatMap(snapshot => snapshot.fileMaterializationPurposes),
        ...(snapshots.some(snapshot => snapshot.requestAuthUses) ? { requestAuthUses: snapshots.flatMap(snapshot => snapshot.requestAuthUses ?? []) } : {}),
        ...(snapshots.some(snapshot => snapshot.fileEnvironmentUses) ? { fileEnvironmentUses: snapshots.flatMap(snapshot => snapshot.fileEnvironmentUses ?? []) } : {}),
        ...(snapshots.some(snapshot => snapshot.environmentUses) ? { environmentUses: snapshots.flatMap(snapshot => snapshot.environmentUses ?? []) } : {}),
        ...(snapshots.some(snapshot => snapshot.environmentUnsetUses) ? { environmentUnsetUses: snapshots.flatMap(snapshot => snapshot.environmentUnsetUses ?? []) } : {}),
    };
}

export function resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn(
    input: Readonly<{
        agentId: string;
        contributions: AgentSpawnPurposeContributions;
        catalogEntry?: AgentSpawnPurposeCatalogEntry | null;
    }>,
): AgentSpawnQualifiedPurposeDeclarationSnapshot | null {
    const declarations = resolveLaunchPurposeDeclarations(input);
    return declarations.length ? mergeLaunchPurposeDeclarationSnapshots(declarations.map(declaration => declaration.snapshot)) : null;
}
