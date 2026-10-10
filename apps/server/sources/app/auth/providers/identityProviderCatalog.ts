import type { AuthProviderId } from "@happier-dev/protocol";
import { normalizeOidcAllowRules } from "@/app/auth/providers/oidc/oidcProviderConfig";
import { managedGitHubAppUserAuthorizationCallbackUrl } from "@/app/integrations/github/githubManagedAppManifest";
import type {
    TeamIdentityEligibleProviderV1,
    IdentityEligibleProviderV1,
    TeamIdentityProviderKindV1,
} from "@happier-dev/protocol/teams";

import type { IdentityProvider } from "@/app/auth/providers/identityProviders/types";
import type { OAuthFlowProvider } from "@/app/oauth/providers/types";
import type { AuthProviderResolver } from "@/app/auth/providers/types";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import {
    resolveDeploymentProviderSnapshot,
    type ProviderModule,
} from "@/app/auth/providers/providerModules";
import {
    HOME_PROVIDER_CONTEXT,
    isSameProviderReference,
    type ProviderCatalogContext,
    type ProviderReference,
    type ProviderRuntimePurpose,
} from "@/app/auth/providers/providerReference";
import { inTx, type Tx } from "@/storage/inTx";
import { resolveConfiguredPublicServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import {
    createOidcProviderModule,
    resolveOidcAuthProviderFeatures,
} from "@/app/auth/providers/oidc/oidcProviderModuleFactory";
import {
    listIdentityProviderInstancesInTx,
    readIdentityProviderInstancePresentationByIdInTx,
    readIdentityProviderInstancePresentationsByIdsInTx,
    resolveIdentityProviderInstanceRuntimeInTx,
    type IdentityProviderInstanceRuntimeResult,
    type IdentityProviderInstanceView,
} from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import { resolveManagedIdentityNetworkPolicy } from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";
import {
    readHomeGovernancePolicyInTx,
    resolveTeamProviderKindPolicy,
} from "@/app/home/governance/governancePolicy";
import {
    computeTeamWorkosConnectionRuntimeFingerprint,
    resolveTeamWorkosConnectionRuntimeInTx,
} from "@/app/auth/providers/workos/teamWorkosConnectionRuntime";
import {
    createWorkosProviderModule,
    extractWorkosLinkedProvider,
    resolveWorkosAuthProviderFeatures,
} from "@/app/auth/providers/workos/workosProviderModuleFactory";
import { resolveWorkosPlatformRuntimeMetadata } from "@/app/integrations/workos/workosPlatform";
import { resolveTeamProviderKindDeploymentAvailability } from "./teamProviderDeploymentCeiling";
import {
    listTeamIdentityConnectionsInTx,
    readTeamIdentityConnectionsByIdInTx,
    readTeamIdentityConnectionInTx,
    teamIdentityConnectionReferenceKey,
    type TeamIdentityConnectionView,
} from "@/app/teams/identity/teamIdentityConnectionLifecycle";
import {
    resolveManagedGitHubAuthProviderFeatures,
    resolveManagedGitHubIdentityProviderModuleInTx,
    resolveManagedGitHubIdentityProviderRuntimeMetadataBatchInTx,
    resolveManagedGitHubIdentityProviderRuntimeMetadataInTx,
    resolveManagedGitHubIdentityProviderConnectionDraftInTx,
    resolveManagedGitHubIdentityProviderPresentationInTx,
} from "@/app/integrations/github/githubManagedIdentityProvider";

/**
 * The one asynchronous identity-provider catalog.
 *
 * Every live provider lookup — OAuth start, identity connect/disconnect, login eligibility, linked
 * provider projection, and profile presentation — resolves here so advertisement and execution can
 * never disagree. `/v1/features` keeps its own synchronous deployment-only projection because
 * request gates and startup viability checks are synchronous; that adapter owns no instance and
 * delegates its only interpretation to the same deployment parser.
 *
 * The operations are asynchronous because the catalog is the seam a database-managed provider
 * source enters. No source registry, loader, descriptor cache, or invalidation bus exists: sources
 * are composed by direct calls, once per operation.
 */

export type ProviderRuntimeResolution<TLeaf> = Readonly<{
    provider: TLeaf;
    reference: ProviderReference;
}>;

export type ProviderRuntimeUnavailableCode =
    /** The bound instance no longer exists in the requested context. */
    | "auth_provider_unavailable"
    /** The instance exists, but the runtime that would execute now is not the bound runtime. */
    | "auth_provider_configuration_changed";

export type ProviderRuntimeResult =
    | Readonly<{ ok: true; module: ProviderModule; reference: ProviderReference }>
    | Readonly<{ ok: false; code: ProviderRuntimeUnavailableCode }>;

export type ProviderDescriptorResolution = Readonly<{
    descriptor: ReturnType<AuthProviderResolver["resolveFeatures"]>;
    reference: ProviderReference;
    /** The catalog identity-provider kind; absent for a built-in OAuth provider. */
    providerKind?: TeamIdentityProviderKindV1;
}>;

function unavailableEligibleProvider(
    provider: Omit<IdentityEligibleProviderV1, "availability">,
    code: Extract<IdentityEligibleProviderV1["availability"], { status: "unavailable" }>["code"],
): IdentityEligibleProviderV1 {
    return { ...provider, availability: { status: "unavailable", code } };
}

/**
 * Projects the safe provider choices for Team connection administration.
 * This is catalog-owned so list UI and live provider resolution share owner,
 * collision, policy, and platform decisions without reading provider secrets.
 */
type EligibleIdentityProvidersInput<TeamId extends string | null> = Readonly<{
    env: NodeJS.ProcessEnv;
    teamId: TeamId;
    connectedProviderInstanceIds: ReadonlySet<string>;
}>;

export function listEligibleTeamIdentityProvidersInTx(tx: Tx, input: EligibleIdentityProvidersInput<string>): Promise<readonly TeamIdentityEligibleProviderV1[]>;
export function listEligibleTeamIdentityProvidersInTx(tx: Tx, input: EligibleIdentityProvidersInput<string | null>): Promise<readonly IdentityEligibleProviderV1[]>;
export async function listEligibleTeamIdentityProvidersInTx(
    tx: Tx,
    input: EligibleIdentityProvidersInput<string | null>,
): Promise<readonly IdentityEligibleProviderV1[]> {
    const context: ProviderCatalogContext = input.teamId === null
        ? HOME_PROVIDER_CONTEXT
        : { kind: "team", teamId: input.teamId };
    const [home, homeRows, teamRows] = await Promise.all([
        readHomeGovernancePolicyInTx(tx),
        listIdentityProviderInstancesInTx(tx, { owner: HOME_PROVIDER_CONTEXT }),
        input.teamId === null ? Promise.resolve([]) : listIdentityProviderInstancesInTx(tx, { owner: context }),
    ]);
    const snapshot = resolveDeploymentProviderSnapshot(input.env);
    const platform = resolveWorkosPlatformRuntimeMetadata(input.env);

    const projectExisting = async (
        resolved: (typeof homeRows)[number],
    ): Promise<IdentityEligibleProviderV1 | null> => {
        if (resolved.status !== "ready") return null;
        const provider = resolved.instance;
        if (context.kind === "home" && provider.kind !== "workos_sso") return null;
        if (
            input.connectedProviderInstanceIds.has(provider.id)
            || snapshot.references.has(normalizeProviderId(provider.id))
        ) return null;
        const base = {
            v: 1 as const,
            providerId: provider.id,
            providerKind: provider.kind,
            owner: provider.owner.kind,
            displayName: provider.displayName,
        };
        const explicitlyBindableTeamGitHubCandidate = provider.kind === "github_app_identity"
            && provider.owner.kind === "team"
            && provider.owner.teamId === input.teamId;
        if (!provider.enabled && !explicitlyBindableTeamGitHubCandidate) {
            return unavailableEligibleProvider(base, "provider_disabled");
        }
        const policy = context.kind === "home" ? "allowed" : resolveTeamProviderKindPolicy(home, provider.kind);
        if (policy === "unavailable") return unavailableEligibleProvider(base, "home_policy_unavailable");
        if (policy === "prohibited") return unavailableEligibleProvider(base, "home_policy_prohibited");
        if (provider.kind === "workos_sso" && !platform.available) {
            return unavailableEligibleProvider(base, "workos_platform_unavailable");
        }
        const githubDraft = provider.kind === "github_app_identity"
            ? await resolveManagedGitHubIdentityProviderConnectionDraftInTx(tx, {
                env: input.env,
                context,
                provider,
            })
            : null;
        if (provider.kind === "github_app_identity" && !githubDraft) {
            return unavailableEligibleProvider(base, "provider_setup_unavailable");
        }
        const connectionDraft = provider.kind === "oidc"
            ? {
                externalReference: { v: 1 as const, kind: "oidc" as const },
                settings: {
                    v: 1 as const,
                    kind: "oidc" as const,
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
            }
            : provider.kind === "workos_sso"
                ? {
                    externalReference: {
                        v: 1 as const,
                        kind: "workos_sso" as const,
                        organizationId: null,
                        connectionId: null,
                    },
                    settings: { v: 1 as const, kind: "workos_sso" as const },
                }
                // The GitHub draft comes from its provider owner rather than
                // being rebuilt here, so the offered binding is byte-identical
                // to the one the create path will accept.
                : githubDraft!;
        return {
            ...base,
            availability: {
                status: "available",
                setupChoice: {
                    kind: "use_existing",
                    providerInstanceId: provider.id,
                    connectionDraft,
                },
            },
        };
    };

    const projectedRows = await Promise.all([
        ...homeRows.map(projectExisting),
        ...teamRows.map(projectExisting),
    ]);
    const existingAvailable = projectedRows.filter((row): row is IdentityEligibleProviderV1 =>
        row !== null && row.availability.status === "available");
    const existingUnavailable = projectedRows.filter((row): row is IdentityEligibleProviderV1 =>
        row !== null && row.availability.status === "unavailable");
    const genericKinds: readonly TeamIdentityProviderKindV1[] = context.kind === "home" ? ["workos_sso"] : [
        "oidc",
        "workos_sso",
        "github_app_identity",
    ];
    const generic = genericKinds.map((providerKind): IdentityEligibleProviderV1 => {
        const base = {
            v: 1 as const,
            providerId: null,
            providerKind,
            owner: context.kind,
            displayName: null,
        };
        const policy = context.kind === "home" ? "allowed" : resolveTeamProviderKindPolicy(home, providerKind);
        if (policy === "unavailable") return unavailableEligibleProvider(base, "home_policy_unavailable");
        if (policy === "prohibited") return unavailableEligibleProvider(base, "home_policy_prohibited");
        const deployment = resolveTeamProviderKindDeploymentAvailability(input.env, providerKind);
        if (deployment !== "available") return unavailableEligibleProvider(base, deployment);
        const actionId = providerKind === "oidc"
            ? "identity.providers.create" as const
            : providerKind === "workos_sso"
                ? context.kind === "home"
                    ? "home.identity.workos.connection.create" as const
                    : "teams.identity.workos.connection.create" as const
                : "identity.githubApps.manifestSetup.start" as const;
        return {
            ...base,
            availability: { status: "available", setupChoice: { kind: "create_managed", actionId } },
        };
    });
    return Object.freeze([...existingAvailable, ...existingUnavailable, ...generic]);
}

/**
 * Lists non-secret provider descriptors. Managed rows are parsed from their safe
 * configuration projection; this path never reads or decrypts secret ciphertext
 * and never constructs a managed OAuth runtime.
 */
export async function listProviderDescriptors(
    env: NodeJS.ProcessEnv,
    context: ProviderCatalogContext = HOME_PROVIDER_CONTEXT,
): Promise<readonly ProviderDescriptorResolution[]> {
    return await inTx(async (tx) => await listProviderDescriptorsInTx(tx, env, context));
}

export async function listProviderDescriptorsInTx(
    tx: Tx,
    env: NodeJS.ProcessEnv,
    context: ProviderCatalogContext = HOME_PROVIDER_CONTEXT,
): Promise<readonly ProviderDescriptorResolution[]> {
    const snapshot = resolveDeploymentProviderSnapshot(env);
    const policy = resolveAuthPolicyFromEnv(env);
    const deploymentIds = snapshot.modules.flatMap((module) => {
        const id = normalizeProviderId(module.id);
        return snapshot.references.get(id)?.source === "deployment" ? [id] : [];
    });
    const managedDeploymentCollisions = new Set((deploymentIds.length === 0
        ? []
        : await tx.identityProviderInstance.findMany({
            where: { id: { in: deploymentIds } },
            select: { id: true },
        })).map(({ id }) => normalizeProviderId(id)));
    const deployment = snapshot.modules.flatMap((module) => {
        const id = normalizeProviderId(module.id);
        const runtime = snapshot.references.get(id);
        if (!id || !runtime || !module.auth) return [];
        if (runtime.source === "deployment" && managedDeploymentCollisions.has(id)) return [];
        return [{
            descriptor: module.auth.resolveFeatures({ env, policy }),
            reference: {
                id,
                source: runtime.source,
                runtimeFingerprint: runtime.runtimeFingerprint,
                context,
            },
            ...(module.auth.providerKind ? { providerKind: module.auth.providerKind } : {}),
        }];
    });

    if (!resolveConfiguredPublicServerUrl(env)) return Object.freeze(deployment);
    const home = await readHomeGovernancePolicyInTx(tx);
    const managed = context.kind === "home"
        ? (await Promise.all((await listIdentityProviderInstancesInTx(tx, { owner: context, enabled: true }))
            .map(async (resolved): Promise<ProviderDescriptorResolution | null> => {
                if (resolved.status !== "ready") return null;
                const instance = resolved.instance;
                const id = normalizeProviderId(instance.id);
                // Built-ins own reserved ids. A deployment/database collision has no
                // winner: both are omitted so source order can never redefine an
                // immutable AccountIdentity provider namespace.
                if (snapshot.references.has(id)) return null;
                if (instance.kind === "oidc" && instance.config.kind === "oidc") {
                    const network = resolveManagedIdentityNetworkPolicy({
                        env,
                        timeoutSeconds: instance.config.httpTimeoutSeconds,
                        home,
                    });
                    return {
                        descriptor: resolveOidcAuthProviderFeatures({
                            displayName: instance.displayName,
                            allow: instance.config.allow,
                            storeRefreshToken: instance.config.storeRefreshToken,
                            ui: instance.config.ui,
                        }, policy),
                        reference: {
                            id,
                            source: "managed" as const,
                            runtimeFingerprint: computeManagedOidcRuntimeFingerprint({
                                securityRevision: instance.securityRevision,
                                connection: null,
                                networkFingerprint: network.fingerprint,
                            }),
                            context,
                        },
                        providerKind: instance.kind,
                    };
                }
                if (instance.kind === "github_app_identity") {
                    const metadata = await resolveManagedGitHubIdentityProviderRuntimeMetadataInTx(tx, {
                        env,
                        context,
                        provider: instance,
                        connectionId: null,
                        connectionRevision: null,
                    });
                    if (!metadata) return null;
                    return {
                        descriptor: resolveManagedGitHubAuthProviderFeatures({
                            displayName: instance.displayName,
                            enabled: true,
                            configured: true,
                        }, policy),
                        reference: {
                            id,
                            source: "managed" as const,
                            runtimeFingerprint: metadata.runtimeFingerprint,
                            context,
                        },
                        providerKind: instance.kind,
                    };
                }
                if (instance.kind === "workos_sso") {
                    const rows = await tx.teamIdentityConnection.findMany({
                        where: { teamId: null, providerInstanceId: instance.id }, select: { id: true },
                    });
                    if (rows.length !== 1) return null;
                    const row = rows[0];
                    const read = await readTeamIdentityConnectionInTx(tx, { id: row.id, teamId: null });
                    if (read.status !== "ready") return null;
                    return projectTeamManagedProviderDescriptor({
                        env, context, connection: read.connection, provider: instance, snapshot, policy, home,
                        platform: resolveWorkosPlatformRuntimeMetadata(env), githubRuntimeFingerprint: null,
                    });
                }
                return null;
            }))).filter((item): item is ProviderDescriptorResolution => item !== null)
        : await listTeamManagedProviderDescriptorsInTx(tx, env, context, snapshot, policy, home);
    return Object.freeze([...deployment, ...managed]);
}

async function readTeamConnectionProviderInTx(
    tx: Tx,
    context: Extract<ProviderCatalogContext, { kind: "team" }>,
    connection: TeamIdentityConnectionView,
): Promise<IdentityProviderInstanceView | null> {
    const resolved = await readIdentityProviderInstancePresentationByIdInTx(tx, {
        id: connection.providerInstanceId,
    });
    if (resolved.status !== "ready") return null;
    return resolved.instance.owner.kind === "home"
        || (resolved.instance.owner.kind === "team" && resolved.instance.owner.teamId === context.teamId)
        ? resolved.instance
        : null;
}

function projectTeamManagedProviderDescriptor(input: Readonly<{
    env: NodeJS.ProcessEnv;
    context: ProviderCatalogContext;
    connection: TeamIdentityConnectionView<string | null>;
    provider: IdentityProviderInstanceView;
    snapshot: ReturnType<typeof resolveDeploymentProviderSnapshot>;
    policy: ReturnType<typeof resolveAuthPolicyFromEnv>;
    home: Awaited<ReturnType<typeof readHomeGovernancePolicyInTx>>;
    platform: ReturnType<typeof resolveWorkosPlatformRuntimeMetadata>;
    githubRuntimeFingerprint: string | null;
}>): ProviderDescriptorResolution | null {
    const { connection, provider } = input;
    if (
        !connection.enabled
        || !provider.enabled
        || input.snapshot.references.has(normalizeProviderId(provider.id))
        || (input.context.kind === "team" && resolveTeamProviderKindPolicy(input.home, provider.kind) !== "allowed")
    ) return null;
    const id = normalizeProviderId(provider.id);
    if (
        provider.kind === "oidc"
        && provider.config.kind === "oidc"
        && connection.externalReference.kind === "oidc"
    ) {
        const network = resolveManagedIdentityNetworkPolicy({
            env: input.env,
            timeoutSeconds: provider.config.httpTimeoutSeconds,
            home: input.home,
        });
        return {
            providerKind: provider.kind,
            descriptor: resolveOidcAuthProviderFeatures({
                displayName: provider.displayName,
                allow: provider.config.allow,
                storeRefreshToken: provider.config.storeRefreshToken,
                ui: provider.config.ui,
            }, input.policy),
            reference: {
                id,
                source: "managed",
                runtimeFingerprint: computeManagedOidcRuntimeFingerprint({
                    securityRevision: provider.securityRevision,
                    connection: { id: connection.id, revision: connection.revision },
                    networkFingerprint: network.fingerprint,
                }),
                context: input.context,
            },
        };
    }
    if (
        provider.kind === "workos_sso"
        && provider.config.kind === "workos_sso"
        && connection.externalReference.kind === "workos_sso"
        && connection.externalReference.organizationId !== null
        && connection.externalReference.connectionId !== null
        && input.platform.available
    ) {
        return {
            providerKind: provider.kind,
            descriptor: resolveWorkosAuthProviderFeatures({
                displayName: provider.displayName,
                enabled: true,
                configured: true,
                scope: input.context.kind,
            }, input.policy),
            reference: {
                id,
                source: "managed",
                runtimeFingerprint: computeTeamWorkosConnectionRuntimeFingerprint({
                    teamId: input.context.kind === "team" ? input.context.teamId : null,
                    connectionId: connection.id,
                    providerInstanceId: provider.id,
                    providerSecurityRevision: provider.securityRevision,
                    connectionRevision: connection.revision,
                    platformRuntimeFingerprint: input.platform.runtimeFingerprint,
                    externalReference: {
                        organizationId: connection.externalReference.organizationId,
                        connectionId: connection.externalReference.connectionId,
                    },
                }),
                context: input.context,
            },
        };
    }
    if (
        provider.kind === "github_app_identity"
        && connection.externalReference.kind === "github_app_identity"
        && input.githubRuntimeFingerprint !== null
    ) {
        return {
            providerKind: provider.kind,
            descriptor: resolveManagedGitHubAuthProviderFeatures({
                displayName: provider.displayName,
                enabled: true,
                configured: true,
            }, input.policy),
            reference: {
                id,
                source: "managed",
                runtimeFingerprint: input.githubRuntimeFingerprint,
                context: input.context,
            },
        };
    }
    return null;
}

async function listTeamManagedProviderDescriptorsInTx(
    tx: Tx,
    env: NodeJS.ProcessEnv,
    context: Extract<ProviderCatalogContext, { kind: "team" }>,
    snapshot: ReturnType<typeof resolveDeploymentProviderSnapshot>,
    policy: ReturnType<typeof resolveAuthPolicyFromEnv>,
    home: Awaited<ReturnType<typeof readHomeGovernancePolicyInTx>>,
): Promise<readonly ProviderDescriptorResolution[]> {
    const connections = await listTeamIdentityConnectionsInTx(tx, { teamId: context.teamId });
    const platform = resolveWorkosPlatformRuntimeMetadata(env);
    const projected = await Promise.all(connections.map(async (connection) => {
        const provider = await readTeamConnectionProviderInTx(tx, context, connection);
        if (!provider) return null;
        const githubMetadata = provider.kind === "github_app_identity"
            ? await resolveManagedGitHubIdentityProviderRuntimeMetadataInTx(tx, {
                env,
                context,
                provider,
                connectionId: connection.id,
                connectionRevision: connection.revision,
            })
            : null;
        return projectTeamManagedProviderDescriptor({
            env,
            context,
            connection,
            provider,
            snapshot,
            policy,
            home,
            platform,
            githubRuntimeFingerprint: githubMetadata?.runtimeFingerprint ?? null,
        });
    }));
    return projected.filter((item) => item !== null);
}

export type TeamAuthenticationConnectionDescriptorRead =
    | Readonly<{
        status: "ready";
        connection: TeamIdentityConnectionView;
        descriptor: ProviderDescriptorResolution | null;
    }>
    | Readonly<{ status: "not_found" | "unreadable" }>;

/**
 * Resolves the exact configured connection/provider descriptors used by Team
 * authentication for a bounded set of Teams. Connection rows, provider
 * instances, Home policy, and GitHub installation readiness are each loaded
 * set-wise; results stay keyed by the exact Team and connection identities.
 */
export async function readTeamAuthenticationConnectionDescriptorsInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        references: readonly Readonly<{ teamId: string; id: string }>[];
    }>,
): Promise<ReadonlyMap<string, TeamAuthenticationConnectionDescriptorRead>> {
    const references = [...new Map(input.references.map((reference) => [
        teamIdentityConnectionReferenceKey(reference),
        reference,
    ])).values()];
    if (references.length === 0) return new Map();
    const connectionReads = await readTeamIdentityConnectionsByIdInTx(tx, { references });
    const connections = [...connectionReads.values()].flatMap((read) =>
        read.status === "ready" ? [read.connection] : []);
    const [home, providerReads] = await Promise.all([
        readHomeGovernancePolicyInTx(tx),
        readIdentityProviderInstancePresentationsByIdsInTx(tx, {
            ids: connections.map((connection) => connection.providerInstanceId),
        }),
    ]);
    const snapshot = resolveDeploymentProviderSnapshot(input.env);
    const policy = resolveAuthPolicyFromEnv(input.env);
    const platform = resolveWorkosPlatformRuntimeMetadata(input.env);
    const githubMetadata = await resolveManagedGitHubIdentityProviderRuntimeMetadataBatchInTx(tx, {
        inputs: connections.flatMap((connection) => {
            const providerRead = providerReads.get(normalizeProviderId(connection.providerInstanceId));
            if (providerRead?.status !== "ready" || providerRead.instance.kind !== "github_app_identity") return [];
            return [{
                key: teamIdentityConnectionReferenceKey(connection),
                env: input.env,
                context: { kind: "team" as const, teamId: connection.teamId },
                provider: providerRead.instance,
                connectionId: connection.id,
                connectionRevision: connection.revision,
            }];
        }),
    });
    const results = new Map<string, TeamAuthenticationConnectionDescriptorRead>();
    for (const connection of connections) {
        const key = teamIdentityConnectionReferenceKey(connection);
        const providerRead = providerReads.get(normalizeProviderId(connection.providerInstanceId));
        const provider = providerRead?.status === "ready" ? providerRead.instance : null;
        const descriptor = provider === null ? null : projectTeamManagedProviderDescriptor({
            env: input.env,
            context: { kind: "team", teamId: connection.teamId },
            connection,
            provider,
            snapshot,
            policy,
            home,
            platform,
            githubRuntimeFingerprint: githubMetadata.get(key)?.runtimeFingerprint ?? null,
        });
        results.set(key, { status: "ready", connection, descriptor });
    }
    for (const reference of references) {
        const key = teamIdentityConnectionReferenceKey(reference);
        if (results.has(key)) continue;
        const read = connectionReads.get(key);
        results.set(key, { status: read?.status === "unreadable" ? "unreadable" : "not_found" });
    }
    return results;
}

/**
 * Non-secret presentation leaves used to project already-linked identities. Loaded once per request
 * so row mapping stays synchronous and cannot fan out into per-identity lookups.
 */
export type ProviderPresentation = Readonly<{
    id: AuthProviderId;
    extractLinkedProvider: IdentityProvider["extractLinkedProvider"];
    extractProfileBadge: IdentityProvider["extractProfileBadge"];
    extractSocialProfile: IdentityProvider["extractSocialProfile"];
}>;

const MANAGED_WORKOS_PRESENTATION: Omit<ProviderPresentation, "id"> = Object.freeze({
    extractLinkedProvider: extractWorkosLinkedProvider,
    extractProfileBadge: undefined,
    extractSocialProfile: undefined,
});

function normalizeProviderId(id: string): AuthProviderId {
    return id.toString().trim().toLowerCase();
}

/** Canonical managed-OIDC runtime identity, shared by safe projection and live construction. */
export function computeManagedOidcRuntimeFingerprint(input: Readonly<{
    securityRevision: number;
    connection: Readonly<{ id: string; revision: number }> | null;
    networkFingerprint: string;
}>): string {
    const connection = input.connection === null
        ? "home"
        : `team:${input.connection.id}:${input.connection.revision}`;
    return `managed-oidc:v1:${input.securityRevision}:${connection}:${input.networkFingerprint}`;
}

function managedIdentityProviderCallbackUrl(
    publicServerUrl: string,
    provider: Readonly<{ id: string; kind: TeamIdentityProviderKindV1 }>,
): string {
    return provider.kind === "github_app_identity"
        ? managedGitHubAppUserAuthorizationCallbackUrl(publicServerUrl)
        : `${publicServerUrl}/v1/oauth/${provider.id}/callback`;
}

/**
 * The redirect URI an administrator registers at the identity provider. It is
 * the same value the runtime below presents as `redirect_uri`, derived from
 * the Home's public server URL and never persisted; `null` when the Home has no
 * public URL, so a projection omits the field instead of showing a guess.
 */
export function identityProviderCallbackUrl(
    publicServerUrl: string | undefined,
    provider: Readonly<{ id: string; kind: TeamIdentityProviderKindV1 }>,
): string | null {
    return publicServerUrl ? managedIdentityProviderCallbackUrl(publicServerUrl, provider) : null;
}

function projectManagedOidcRuntime(input: Readonly<{
    env: NodeJS.ProcessEnv;
    context: ProviderCatalogContext;
    publicServerUrl: string;
    home: Awaited<ReturnType<typeof readHomeGovernancePolicyInTx>>;
    resolved: IdentityProviderInstanceRuntimeResult;
    connection: Pick<TeamIdentityConnectionView, "id" | "revision" | "settings"> | null;
}>): Readonly<{ module: ProviderModule; reference: ProviderReference }> | null {
    const { resolved } = input;
    if (
        resolved.status !== "ready"
        || resolved.instance.kind !== "oidc"
        || resolved.instance.config.kind !== "oidc"
        || resolved.secrets?.kind !== "oidc"
    ) return null;
    const config = resolved.instance.config;
    const connectionSettings = input.connection?.settings.kind === "oidc"
        ? input.connection.settings
        : null;
    const connectionAllow = connectionSettings
        ? normalizeOidcAllowRules({
            usersAllowlist: connectionSettings.allowedUsers,
            emailDomains: connectionSettings.allowedEmailDomains,
            groupsAny: connectionSettings.groupsAny,
            groupsAll: connectionSettings.groupsAll,
        })
        : null;
    const network = resolveManagedIdentityNetworkPolicy({
        env: input.env,
        timeoutSeconds: config.httpTimeoutSeconds,
        home: input.home,
    });
    const runtimeFingerprint = computeManagedOidcRuntimeFingerprint({
        securityRevision: resolved.instance.securityRevision,
        connection: input.connection,
        networkFingerprint: network.fingerprint,
    });
    return {
        module: createOidcProviderModule({
            id: resolved.instance.id,
            type: "oidc",
            displayName: resolved.instance.displayName,
            issuer: config.issuer,
            clientId: config.clientId,
            clientSecret: resolved.secrets.clientSecret,
            clientAuthenticationMethod: config.clientAuthenticationMethod,
            redirectUrl: managedIdentityProviderCallbackUrl(input.publicServerUrl, resolved.instance),
            scopes: config.scopes,
            httpTimeoutSeconds: config.httpTimeoutSeconds,
            claims: config.claims,
            allow: config.allow,
            fetchUserInfo: config.fetchUserInfo,
            storeRefreshToken: config.storeRefreshToken,
            ui: config.ui,
        }, runtimeFingerprint, network.policy, input.context.kind === "team" && input.connection
            ? {
                teamId: input.context.teamId,
                connectionId: input.connection.id,
                allow: connectionAllow ?? config.allow,
            }
            : undefined),
        reference: {
            id: resolved.instance.id,
            source: "managed",
            runtimeFingerprint,
            context: input.context,
        },
    };
}

async function resolveManagedModuleWithReferenceInTx(
    tx: Tx,
    env: NodeJS.ProcessEnv,
    id: string,
    context: ProviderCatalogContext,
    purpose: ProviderRuntimePurpose,
): Promise<Readonly<{ module: ProviderModule; reference: ProviderReference }> | null> {
    const publicServerUrl = resolveConfiguredPublicServerUrl(env);
    if (!publicServerUrl) return null;
    const includeDisabled = purpose === "identity_connection_test";
    const connectionRow = context.kind === "team"
        ? await tx.teamIdentityConnection.findUnique({
            where: { teamId_providerInstanceId: { teamId: context.teamId, providerInstanceId: id } },
            select: { id: true },
        })
        : null;
    const connectionResult = context.kind === "team" && connectionRow
        ? await readTeamIdentityConnectionInTx(tx, { id: connectionRow.id, teamId: context.teamId })
        : null;
    const connection = connectionResult?.status === "ready" ? connectionResult.connection : null;
    if (context.kind === "team" && !connection && !includeDisabled) return null;
    if (context.kind === "team" && connection && !connection.enabled && !includeDisabled) return null;
    let resolved = await resolveIdentityProviderInstanceRuntimeInTx(tx, {
        id,
        owner: context,
        ...(includeDisabled ? { includeDisabled: true } : {}),
    });
    if (context.kind === "team" && resolved.status === "not_found") {
        // A Team-owned provider draft can be validated before its connection is
        // created. A Home-owned provider is reachable in Team context only
        // through an existing Team connection.
        if (!connection) return null;
        resolved = await resolveIdentityProviderInstanceRuntimeInTx(tx, {
            id,
            owner: HOME_PROVIDER_CONTEXT,
            ...(includeDisabled ? { includeDisabled: true } : {}),
        });
    }
    if (resolved.status !== "ready") return null;
    const home = await readHomeGovernancePolicyInTx(tx);
    // The Home's Team provider ceiling is decided once, here: the descriptor
    // list already omits a prohibited kind, and the runtime that would start,
    // complete or finalize a Team flow refuses it for the same reason.
    if (context.kind === "team" && resolveTeamProviderKindPolicy(home, resolved.instance.kind) !== "allowed") {
        return null;
    }
    if (resolved.instance.kind === "oidc") {
        return projectManagedOidcRuntime({
            env,
            context,
            publicServerUrl,
            home,
            resolved,
            connection: connection ? {
                id: connection.id,
                revision: connection.revision,
                settings: connection.settings,
            } : null,
        });
    }
    if (resolved.instance.kind === "github_app_identity") {
        const github = await resolveManagedGitHubIdentityProviderModuleInTx(tx, {
            env,
            context,
            provider: resolved.instance,
            connectionId: connection?.id ?? null,
            connectionRevision: connection?.revision ?? null,
            publicServerUrl,
        });
        return github
            ? {
                module: github.module,
                reference: {
                    id: resolved.instance.id,
                    source: "managed",
                    runtimeFingerprint: github.runtimeFingerprint,
                    context,
                },
            }
            : null;
    }
    return null;
}

async function resolveTeamWorkosModuleWithReferenceInTx(
    tx: Tx,
    env: NodeJS.ProcessEnv,
    id: string,
    context: ProviderCatalogContext,
    purpose: ProviderRuntimePurpose,
): Promise<Readonly<{ module: ProviderModule; reference: ProviderReference }> | null> {
    const teamId = context.kind === "team" ? context.teamId : null;
    const connections = await tx.teamIdentityConnection.findMany({
        where: { teamId, providerInstanceId: id },
        select: { id: true },
    });
    if (connections.length !== 1) return null;
    const connection = connections[0];
    const runtime = await resolveTeamWorkosConnectionRuntimeInTx(tx, {
        env,
        teamId,
        connectionId: connection.id,
        ...(purpose === "identity_connection_test" ? { includeDisabled: true } : {}),
    });
    if (runtime.status !== "ready") return null;
    if (context.kind === "team" && resolveTeamProviderKindPolicy(await readHomeGovernancePolicyInTx(tx), "workos_sso") !== "allowed") return null;
    const publicServerUrl = resolveConfiguredPublicServerUrl(env);
    if (!publicServerUrl) return null;
    return {
        module: createWorkosProviderModule({
            providerInstanceId: runtime.provider.id,
            displayName: runtime.provider.displayName,
            enabled: runtime.provider.enabled && runtime.connection.enabled,
            redirectUrl: managedIdentityProviderCallbackUrl(publicServerUrl, { id: runtime.provider.id, kind: "workos_sso" }),
            externalReference: runtime.connection.externalReference,
            platform: runtime.platform,
            connectionBinding: { id: runtime.connection.id, revision: runtime.connection.revision },
            ...(context.kind === "team" ? { teamConnection: { teamId: context.teamId, connectionId: connection.id } } : {}),
        }),
        reference: {
            id: runtime.provider.id,
            source: "managed",
            runtimeFingerprint: runtime.runtimeFingerprint,
            context,
        },
    };
}

async function resolveModuleWithReferenceInTx(
    tx: Tx,
    env: NodeJS.ProcessEnv,
    id: string,
    context: ProviderCatalogContext,
    purpose: ProviderRuntimePurpose = "oauth_start",
): Promise<Readonly<{ module: ProviderModule; reference: ProviderReference }> | null> {
    const normalized = normalizeProviderId(id);
    if (!normalized) return null;

    const snapshot = resolveDeploymentProviderSnapshot(env);
    const module = snapshot.modules.find((candidate) => normalizeProviderId(candidate.id) === normalized);
    if (!module) {
        const workos = await resolveTeamWorkosModuleWithReferenceInTx(tx, env, normalized, context, purpose);
        return workos ?? await resolveManagedModuleWithReferenceInTx(tx, env, normalized, context, purpose);
    }

    const runtime = snapshot.references.get(normalized);
    // Fail closed: a composed module without a settled runtime reference cannot be bound or compared.
    if (!runtime) return null;
    if (runtime.source === "deployment" && await tx.identityProviderInstance.findUnique({
        where: { id: normalized },
        select: { id: true },
    })) return null;

    return {
        module,
        reference: {
            id: normalized,
            source: runtime.source,
            runtimeFingerprint: runtime.runtimeFingerprint,
            context,
        },
    };
}

async function resolveModuleWithReference(
    env: NodeJS.ProcessEnv,
    id: string,
    context: ProviderCatalogContext,
    purpose: ProviderRuntimePurpose = "oauth_start",
): Promise<Readonly<{ module: ProviderModule; reference: ProviderReference }> | null> {
    return await inTx(async (tx) => await resolveModuleWithReferenceInTx(tx, env, id, context, purpose));
}

/** Resolves the whole provider module plus its current reference in the Home context. */
export async function resolveProviderRuntimeById(
    env: NodeJS.ProcessEnv,
    id: string,
    context: ProviderCatalogContext = HOME_PROVIDER_CONTEXT,
    purpose: ProviderRuntimePurpose = "oauth_start",
): Promise<ProviderRuntimeResolution<ProviderModule> | null> {
    const resolved = await resolveModuleWithReference(env, id, context, purpose);
    if (!resolved) return null;
    return { provider: resolved.module, reference: resolved.reference };
}

/** Resolves the OAuth leaf of one provider instance plus the reference callers must bind. */
export async function resolveOAuthRuntimeById(
    env: NodeJS.ProcessEnv,
    id: string,
    context: ProviderCatalogContext = HOME_PROVIDER_CONTEXT,
    purpose: ProviderRuntimePurpose = "oauth_start",
): Promise<ProviderRuntimeResolution<OAuthFlowProvider> | null> {
    const resolved = await resolveModuleWithReference(env, id, context, purpose);
    if (!resolved?.module.oauth) return null;
    return { provider: resolved.module.oauth, reference: resolved.reference };
}

export async function resolveOAuthRuntimeByIdInTx(
    tx: Tx,
    env: NodeJS.ProcessEnv,
    id: string,
    context: ProviderCatalogContext = HOME_PROVIDER_CONTEXT,
    purpose: ProviderRuntimePurpose = "oauth_start",
): Promise<ProviderRuntimeResolution<OAuthFlowProvider> | null> {
    const resolved = await resolveModuleWithReferenceInTx(tx, env, id, context, purpose);
    if (!resolved?.module.oauth) return null;
    return { provider: resolved.module.oauth, reference: resolved.reference };
}

/** Resolves the identity leaf of one provider instance plus its current reference. */
export async function resolveIdentityRuntimeById(
    env: NodeJS.ProcessEnv,
    id: string,
    context: ProviderCatalogContext = HOME_PROVIDER_CONTEXT,
): Promise<ProviderRuntimeResolution<IdentityProvider> | null> {
    const resolved = await resolveModuleWithReference(env, id, context);
    if (!resolved?.module.identity) return null;
    return { provider: resolved.module.identity, reference: resolved.reference };
}

/** Resolves the auth-policy leaf of one provider instance plus its current reference. */
export async function resolveAuthRuntimeById(
    env: NodeJS.ProcessEnv,
    id: string,
    context: ProviderCatalogContext = HOME_PROVIDER_CONTEXT,
): Promise<ProviderRuntimeResolution<AuthProviderResolver> | null> {
    const resolved = await resolveModuleWithReference(env, id, context);
    if (!resolved?.module.auth) return null;
    return { provider: resolved.module.auth, reference: resolved.reference };
}

/**
 * Re-resolves a previously bound reference and proves the runtime that would execute now is the
 * runtime that was bound.
 *
 * `purpose` is a closed internal guard describing which provider operation the runtime serves; it is
 * distinct from the persisted OAuth-attempt purpose. Built-in and deployment instances have no
 * enabled state or context restriction, so every purpose is eligible for them today. Purposes exist
 * on this boundary so callback and finalization comparisons state which operation they authorize.
 */
export async function resolveRuntime(input: {
    env: NodeJS.ProcessEnv;
    reference: ProviderReference;
    purpose: ProviderRuntimePurpose;
}): Promise<ProviderRuntimeResult> {
    return await inTx(async (tx) => await resolveRuntimeInTx(tx, input));
}

export async function resolveRuntimeInTx(tx: Tx, input: {
    env: NodeJS.ProcessEnv;
    reference: ProviderReference;
    purpose: ProviderRuntimePurpose;
}): Promise<ProviderRuntimeResult> {
    const resolved = await resolveModuleWithReferenceInTx(
        tx,
        input.env,
        input.reference.id,
        input.reference.context,
        input.purpose,
    );
    if (!resolved) return { ok: false, code: "auth_provider_unavailable" };
    if (!isSameProviderReference(resolved.reference, input.reference)) {
        return { ok: false, code: "auth_provider_configuration_changed" };
    }
    return { ok: true, module: resolved.module, reference: resolved.reference };
}

/**
 * Batches the presentation leaves for a set of already-linked provider ids.
 *
 * Ids with no current provider instance are omitted: a linked identity for a removed provider still
 * projects through its stored row, it simply has no provider-specific presentation left.
 */
export async function describeLinkedIds(input: {
    env: NodeJS.ProcessEnv;
    providerIds: readonly string[];
}): Promise<ReadonlyMap<AuthProviderId, ProviderPresentation>> {
    return await inTx((tx) => describeLinkedIdsInTx(tx, input));
}

export async function describeLinkedIdsInTx(tx: Tx, input: {
    env: NodeJS.ProcessEnv;
    providerIds: readonly string[];
}): Promise<ReadonlyMap<AuthProviderId, ProviderPresentation>> {
    const wanted = new Set(input.providerIds.map(normalizeProviderId).filter(Boolean));
    const presentation = new Map<AuthProviderId, ProviderPresentation>();
    if (wanted.size === 0) return presentation;

    const [descriptors, managed] = await Promise.all([
        listProviderDescriptorsInTx(tx, input.env, HOME_PROVIDER_CONTEXT),
        readIdentityProviderInstancePresentationsByIdsInTx(tx, { ids: [...wanted] }),
    ]);
    const snapshot = resolveDeploymentProviderSnapshot(input.env);
    for (const { reference } of descriptors) {
        const id = normalizeProviderId(reference.id);
        if (!wanted.has(id) || reference.source === "managed") continue;
        const module = snapshot.modules.find((candidate) => normalizeProviderId(candidate.id) === id) ?? null;
        presentation.set(id, {
            id,
            extractLinkedProvider: module?.identity?.extractLinkedProvider,
            extractProfileBadge: module?.identity?.extractProfileBadge,
            extractSocialProfile: module?.identity?.extractSocialProfile,
        });
    }

    for (const [id, resolved] of managed) {
        if (resolved.status !== "ready" || snapshot.references.has(id)) continue;
        const leaves = resolved.instance.kind === "workos_sso"
            ? MANAGED_WORKOS_PRESENTATION
            : await resolveManagedGitHubIdentityProviderPresentationInTx(tx, resolved.instance);
        presentation.set(id, {
            id,
            extractLinkedProvider: leaves?.extractLinkedProvider,
            extractProfileBadge: leaves?.extractProfileBadge,
            extractSocialProfile: leaves?.extractSocialProfile,
        });
    }

    return presentation;
}
