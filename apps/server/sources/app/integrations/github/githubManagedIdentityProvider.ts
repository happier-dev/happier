import type {
    TeamIdentityConnectionExternalReferenceV1,
    TeamIdentityConnectionSettingsV1,
} from "@happier-dev/protocol/teams";

import type { ProviderModule } from "@/app/auth/providers/providerModules";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { ProviderCatalogContext } from "@/app/auth/providers/providerReference";
import type { IdentityProviderInstanceView } from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import type { OutboundIdentityNetworkPolicy } from "@/app/net/outboundIdentityNetworkPolicy";
import type { IdentityProvider } from "@/app/auth/providers/identityProviders/types";
import type { AuthProviderFeatures } from "@/app/auth/providers/types";
import type { TeamAuthenticationReadCapture } from '@/app/auth/entry/teamAuthenticationReadCapture';

import { prepareIdentityLink, refreshIdentity, unlinkIdentity } from "@/app/auth/providers/accountIdentityLifecycle";
import { db, getDbProviderFromEnv } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { prepareIdentityConnectionGroupRefresh } from "@/app/teams/memberships/identityConnectionGroupRefresh";
import { resolveManagedIdentityNetworkPolicy } from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";
import { bindDirectoryProvisionedIdentitiesInTx, type DirectoryProvisionedIdentityMatch } from "@/app/teams/directory/provisionedIdentityBinding";

import {
    MANAGED_GITHUB_APP_CALLBACK_PROVIDER_ID,
    createManagedGitHubUserOAuthProvider,
    managedGitHubAppUserAuthorizationCallbackUrl,
    parseManagedGitHubUserProfile,
} from "./githubManagedUserOAuth";
import {
    readGitHubTeamMembershipObservation,
    verifyGitHubOrganizationMember,
} from "./githubAppInstallationClient";
import {
    decryptGitHubAppRegistrationSecretsV1,
    parseGitHubAppRegistrationConfigV1,
    parseGitHubPermissionsV1,
    projectGitHubAppSecretHealthV1,
    resolveGitHubAppConsumerReadinessV1,
    type GitHubAppRegistrationSecretHealthFact,
} from "./githubManagedApp";
import {
    isGitHubAppRegistrationOwnerEligible,
    isManagedGitHubHostApprovedByHome,
} from "./githubAppInstallationEligibility";
import { readHomeGovernancePolicyInTx, type HomeGovernancePolicyRecord } from "@/app/home/governance/governancePolicy";
import { portableQueryChunks } from "@/storage/portableQueryChunks";

export type ManagedGitHubIdentityProviderModuleInput = Readonly<{
    providerId: string;
    callbackProviderId?: string;
    displayName: string;
    context: ProviderCatalogContext;
    connectionId: string | null;
    githubHost: string;
    githubAppId: bigint;
    githubClientId: string;
    clientSecret: string;
    privateKey: string;
    githubInstallationId: bigint;
    githubAppInstallationRecordId: string;
    githubOrganizationId: bigint;
    githubOrganizationLogin: string;
    redirectUrl: string;
    networkPolicy: OutboundIdentityNetworkPolicy;
}>;

export type ResolveManagedGitHubIdentityProviderModuleResult = Readonly<{
    module: ProviderModule;
    runtimeFingerprint: string;
    connectionRevision: number | null;
}>;

export type ManagedGitHubIdentityProviderRuntimeFacts = Readonly<{
    modules: ReadonlyMap<string, ResolveManagedGitHubIdentityProviderModuleResult>;
    registrationSecretHealthByKey: ReadonlyMap<string, GitHubAppRegistrationSecretHealthFact>;
}>;

export type ManagedGitHubIdentityProviderRuntimeMetadata = Readonly<{
    runtimeFingerprint: string;
    networkPolicy: OutboundIdentityNetworkPolicy;
}>;

export type ManagedGitHubIdentityPresentation = Pick<
    IdentityProvider,
    "extractLinkedProvider" | "extractProfileBadge" | "extractSocialProfile"
>;

export function createManagedGitHubIdentityPresentation(
    githubHost: string,
): ManagedGitHubIdentityPresentation {
    const profileBaseUrl = githubHost.replace(/\/$/u, "");
    return Object.freeze({
        extractSocialProfile: ({ profile }) => {
            try {
                return { bio: null, suggestedUsername: parseManagedGitHubUserProfile(profile).login };
            } catch {
                return { bio: null, suggestedUsername: null };
            }
        },
        extractLinkedProvider: ({ profile, providerLogin }) => {
            let parsed: ReturnType<typeof parseManagedGitHubUserProfile> | null = null;
            try { parsed = parseManagedGitHubUserProfile(profile); } catch { /* unreadable stored profile */ }
            const login = parsed?.login ?? providerLogin?.trim() ?? null;
            return {
                displayName: parsed?.name?.trim() || null,
                avatarUrl: parsed?.avatar_url?.trim() || null,
                profileUrl: login ? `${profileBaseUrl}/${encodeURIComponent(login)}` : null,
            };
        },
        extractProfileBadge: ({ profile, providerLogin }) => {
            let parsed: ReturnType<typeof parseManagedGitHubUserProfile> | null = null;
            try { parsed = parseManagedGitHubUserProfile(profile); } catch { /* unreadable stored profile */ }
            const login = parsed?.login ?? providerLogin?.trim() ?? null;
            return login
                ? { label: `@${login}`, url: `${profileBaseUrl}/${encodeURIComponent(login)}` }
                : null;
        },
    });
}

/** Safe presentation lookup for an already-linked immutable managed provider id. */
export async function resolveManagedGitHubIdentityProviderPresentationInTx(
    tx: Tx,
    provider: IdentityProviderInstanceView,
): Promise<ManagedGitHubIdentityPresentation | null> {
    if (provider.kind !== "github_app_identity" || provider.githubAppInstallationId === null) return null;
    const installation = await tx.gitHubAppInstallation.findUnique({
        where: { id: provider.githubAppInstallationId },
        select: { registration: { select: { githubHost: true } } },
    });
    return installation
        ? createManagedGitHubIdentityPresentation(installation.registration.githubHost)
        : null;
}

type ManagedGitHubIdentityProviderReadiness = Readonly<{
    installationId: string;
    organizationLogin: string;
    providerSecurityRevision: number;
    registrationSecurityRevision: number;
    installationRevision: number;
    networkFingerprint: string;
    networkPolicy: OutboundIdentityNetworkPolicy;
}>;

async function resolveManagedGitHubIdentityProviderReadinessInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
    }>,
): Promise<ManagedGitHubIdentityProviderReadiness | null> {
    const captured = await captureManagedGitHubIdentityProviderFactsInTx(tx, {
        inputs: [{ ...input, key: "single", connectionRevision: null }],
        includeSecrets: false,
    });
    return captured.get("single")?.readiness ?? null;
}

export async function isManagedGitHubIdentityProviderAvailableForConnectionInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
    }>,
): Promise<boolean> {
    return await resolveManagedGitHubIdentityProviderReadinessInTx(tx, input) !== null;
}

/**
 * The exact connection a Team binding for this GitHub provider must carry.
 *
 * Both the eligible-provider projection an administrator is shown and the
 * create-connection path that validates what they send back read this one
 * result. Building the reference/settings pair separately in each place would
 * let the offered draft and the accepted draft drift, and the only symptom
 * would be an `identity_connection_invalid` rejection of the exact values the
 * server itself proposed.
 */
type ManagedGitHubIdentityProviderConnectionDraft = Readonly<{
    externalReference: Extract<TeamIdentityConnectionExternalReferenceV1, { kind: "github_app_identity" }>;
    settings: Extract<TeamIdentityConnectionSettingsV1, { kind: "github_app_identity" }>;
}>;

export async function resolveManagedGitHubIdentityProviderConnectionDraftInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
    }>,
): Promise<ManagedGitHubIdentityProviderConnectionDraft | null> {
    return (await resolveManagedGitHubIdentityProviderConnectionDraftsInTx(tx, {
        inputs: [{ ...input, key: "single" }],
    })).get("single") ?? null;
}

/** Secret-free setup drafts share the same fresh readiness acquisition as runtime consumers. */
export async function resolveManagedGitHubIdentityProviderConnectionDraftsInTx(
    tx: Tx,
    input: Readonly<{
        inputs: readonly Readonly<{
            key: string;
            env: NodeJS.ProcessEnv;
            context: ProviderCatalogContext;
            provider: IdentityProviderInstanceView;
        }>[];
        home?: HomeGovernancePolicyRecord;
    }>,
): Promise<ReadonlyMap<string, ManagedGitHubIdentityProviderConnectionDraft>> {
    const captured = await captureManagedGitHubIdentityProviderFactsInTx(tx, {
        home: input.home,
        inputs: input.inputs.map(candidate => ({ ...candidate, connectionRevision: null })),
        includeSecrets: false,
    });
    return new Map<string, ManagedGitHubIdentityProviderConnectionDraft>([...captured].map(([key, { readiness }]) => [key, {
        externalReference: { v: 1, kind: "github_app_identity", installationId: readiness.installationId },
        settings: { v: 1, kind: "github_app_identity", organizationLogin: readiness.organizationLogin },
    }]));
}

export function resolveManagedGitHubAuthProviderFeatures(
    input: Readonly<{ displayName: string; enabled: boolean; configured: boolean }>,
    policy: AuthPolicy,
): AuthProviderFeatures {
    return {
        enabled: input.enabled,
        configured: input.configured,
        ui: {
            displayName: input.displayName,
            iconHint: "github",
            connectButtonColor: "#24292F",
            supportsProfileBadge: true,
            badgeIconName: "github",
        },
        restrictions: { usersAllowlist: false, orgsAllowlist: true, orgMatch: "all" },
        offboarding: {
            enabled: policy.offboarding.enabled,
            intervalSeconds: policy.offboarding.intervalSeconds,
            mode: policy.offboarding.mode,
            source: "managed_github_app",
        },
    };
}

export async function resolveManagedGitHubIdentityProviderRuntimeMetadataInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
        connectionId: string | null;
        connectionRevision: number | null;
    }>,
): Promise<ManagedGitHubIdentityProviderRuntimeMetadata | null> {
    const key = "single";
    return (await resolveManagedGitHubIdentityProviderRuntimeMetadataBatchInTx(tx, {
        inputs: [{ ...input, key }],
    })).get(key) ?? null;
}

/** Loads current GitHub registration/installation facts once for a bounded set
 * of authentication descriptors. Each result remains bound to its caller key,
 * exact owner context, provider lifetime, and connection revision. */
export async function resolveManagedGitHubIdentityProviderRuntimeMetadataBatchInTx(
    tx: Tx,
    input: Readonly<{ inputs: readonly Readonly<{
        key: string;
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
        connectionId: string | null;
        connectionRevision: number | null;
    }>[]; home?: HomeGovernancePolicyRecord }>,
    readCapture?: TeamAuthenticationReadCapture,
): Promise<ReadonlyMap<string, ManagedGitHubIdentityProviderRuntimeMetadata>> {
    const captured = await captureManagedGitHubIdentityProviderFactsInTx(tx, {
        ...input,
        inputs: input.inputs.filter(hasManagedGitHubRuntimeBinding),
        includeSecrets: false,
    }, readCapture);
    return new Map([...captured].map(([key, value]) => [key, value.metadata]));
}

type ManagedGitHubIdentityProviderRuntimeInput = Readonly<{
    key: string;
    env: NodeJS.ProcessEnv;
    context: ProviderCatalogContext;
    provider: IdentityProviderInstanceView;
    connectionId: string | null;
    connectionRevision: number | null;
}>;

function hasManagedGitHubRuntimeBinding(candidate: ManagedGitHubIdentityProviderRuntimeInput): boolean {
    return (candidate.context.kind === "team") === (candidate.connectionId !== null)
        && (candidate.connectionId === null) === (candidate.connectionRevision === null)
        && (candidate.connectionRevision === null || candidate.connectionRevision >= 1);
}

/** Shared fresh acquisition and readiness owner for drafts, metadata, and live modules. */
async function captureManagedGitHubIdentityProviderFactsInTx(
    tx: Tx,
    input: Readonly<{
        inputs: readonly Omit<ManagedGitHubIdentityProviderRuntimeInput, "connectionId">[];
        includeSecrets: boolean;
        /** Already admitted by the caller in this same transaction. */
        home?: HomeGovernancePolicyRecord;
    }>,
    readCapture?: TeamAuthenticationReadCapture,
) {
    const candidates = input.inputs.filter(candidate =>
        candidate.provider.kind === "github_app_identity"
        && candidate.provider.config.kind === "github_app_identity"
        && candidate.provider.githubAppInstallationId !== null
        && (candidate.context.kind !== "home" || candidate.provider.owner.kind === "home")
        && (candidate.provider.owner.kind !== "team"
            || (candidate.context.kind === "team" && candidate.context.teamId === candidate.provider.owner.teamId)));
    const ids = [...new Set(candidates.flatMap(candidate =>
        candidate.provider.githubAppInstallationId ? [candidate.provider.githubAppInstallationId] : []))];
    const [home, installationBatches] = await Promise.all([
        candidates.length === 0 ? null : input.home ?? readHomeGovernancePolicyInTx(tx, readCapture),
        // Only the portable SQL bind boundary adds chunks, never a product list cap.
        readCapture ? [readCapture.installations.filter(installation => ids.includes(installation.id))]
            : Promise.all(portableQueryChunks({ values: ids, bindingsPerValue: 1, fixedBindings: 1 }).map(installationIds =>
            tx.gitHubAppInstallation.findMany({
                // Keep installation and registration facts in one joined snapshot.
                // SQLite's enclosing write admission already excludes other writers.
                ...(getDbProviderFromEnv(process.env, "postgres") === "sqlite" ? {} : { relationLoadStrategy: "join" as const }),
                where: { id: { in: [...installationIds] } },
                select: {
                    id: true,
                    githubInstallationId: true,
                    githubOrganizationId: true,
                    githubOrganizationLogin: true,
                    revision: true,
                    state: true,
                    verifiedPermissions: true,
                    suspendedAt: true,
                    lastVerifiedAt: true,
                    registration: { select: {
                        id: true,
                        ownerTeamId: true,
                        githubHost: true,
                        githubAppId: true,
                        githubClientId: true,
                        config: true,
                        securityRevision: true,
                        state: true,
                        lastVerifiedAt: true,
                        encryptedSecrets: input.includeSecrets,
                    } },
                },
            }))),
    ]);
    const installations = installationBatches.flat();
    const results = new Map<string, Readonly<{
        installation: typeof installations[number];
        readiness: ManagedGitHubIdentityProviderReadiness;
        metadata: ManagedGitHubIdentityProviderRuntimeMetadata;
    }>>();
    if (home === null) return results;
    const registrationConfigs = new Map<string, ReturnType<typeof parseGitHubAppRegistrationConfigV1> | null>();
    const readyInstallations = new Map<string, typeof installations[number]>();
    for (const installation of installations) {
        if (
            installation.state !== "verified"
            || installation.suspendedAt !== null
            || installation.lastVerifiedAt === null
            || installation.registration.state !== "verified"
            || installation.registration.lastVerifiedAt === null
            || !isManagedGitHubHostApprovedByHome(home, installation.registration.githubHost)
        ) continue;
        const registrationKey = JSON.stringify([installation.registration.id, installation.registration.securityRevision]);
        let config = registrationConfigs.get(registrationKey);
        let permissions: ReturnType<typeof parseGitHubPermissionsV1>;
        try {
            if (config === undefined) {
                try {
                    config = parseGitHubAppRegistrationConfigV1(installation.registration.config);
                    registrationConfigs.set(registrationKey, config);
                } catch {
                    registrationConfigs.set(registrationKey, null);
                    continue;
                }
            }
            if (config === null) continue;
            permissions = parseGitHubPermissionsV1(installation.verifiedPermissions);
        } catch {
            continue;
        }
        if (!resolveGitHubAppConsumerReadinessV1({
            purpose: { kind: "identity", requiresOrganizationEvidence: true },
            registration: {
                state: installation.registration.state,
                secretHealth: config.secretHealth ?? {
                    clientSecretConfigured: false,
                    privateKeyConfigured: false,
                    webhookSecretConfigured: false,
                },
            },
            installation: {
                state: installation.state,
                suspended: installation.suspendedAt !== null,
                permissions,
                events: [],
            },
        }).ok) continue;
        readyInstallations.set(installation.id, installation);
    }
    for (const candidate of candidates) {
        const installation = candidate.provider.githubAppInstallationId
            ? readyInstallations.get(candidate.provider.githubAppInstallationId) : undefined;
        if (!installation || !isGitHubAppRegistrationOwnerEligible(installation.registration.ownerTeamId, candidate.context)) continue;
        const network = resolveManagedIdentityNetworkPolicy({ env: candidate.env, timeoutSeconds: 30, home });
        const metadata: ManagedGitHubIdentityProviderRuntimeMetadata = {
            runtimeFingerprint: [
                "managed-github:v1",
                candidate.provider.securityRevision,
                installation.registration.securityRevision,
                installation.revision,
                candidate.connectionRevision ?? "home",
                network.fingerprint,
            ].join(":"),
            networkPolicy: network.policy,
        };
        results.set(candidate.key, {
            installation,
            metadata,
            readiness: {
                installationId: installation.id,
                organizationLogin: installation.githubOrganizationLogin,
                providerSecurityRevision: candidate.provider.securityRevision,
                registrationSecurityRevision: installation.registration.securityRevision,
                installationRevision: installation.revision,
                networkFingerprint: network.fingerprint,
                networkPolicy: network.policy,
            },
        });
    }
    return results;
}

export async function resolveManagedGitHubIdentityProviderModuleInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
        connectionId: string | null;
        connectionRevision: number | null;
        publicServerUrl: string;
    }>,
): Promise<ResolveManagedGitHubIdentityProviderModuleResult | null> {
    return (await resolveManagedGitHubIdentityProviderModulesInTx(tx, {
        inputs: [{ ...input, key: "single" }],
    })).get("single") ?? null;
}

/** Resolve live leaves from one admitted snapshot, decrypting each registration once. */
export async function resolveManagedGitHubIdentityProviderModulesInTx(
    tx: Tx,
    input: Readonly<{ inputs: readonly Readonly<{
        key: string;
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
        connectionId: string | null;
        connectionRevision: number | null;
        publicServerUrl: string;
    }>[]; home?: HomeGovernancePolicyRecord }>,
): Promise<ReadonlyMap<string, ResolveManagedGitHubIdentityProviderModuleResult>> {
    return (await resolveManagedGitHubIdentityProviderRuntimeFactsInTx(tx, input)).modules;
}

/** Retain safe decrypted health even when these credentials cannot construct an OAuth module. */
export async function resolveManagedGitHubIdentityProviderRuntimeFactsInTx(
    tx: Tx,
    input: Readonly<{ inputs: readonly Readonly<{
        key: string;
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
        connectionId: string | null;
        connectionRevision: number | null;
        publicServerUrl: string;
    }>[]; home?: HomeGovernancePolicyRecord }>,
    readCapture?: TeamAuthenticationReadCapture,
): Promise<ManagedGitHubIdentityProviderRuntimeFacts> {
    const candidates = input.inputs.filter(hasManagedGitHubRuntimeBinding);
    const captured = await captureManagedGitHubIdentityProviderFactsInTx(tx, {
        inputs: candidates,
        home: input.home,
        includeSecrets: true,
    }, readCapture);
    const results = new Map<string, ResolveManagedGitHubIdentityProviderModuleResult>();
    const registrationSecretHealthByKey = new Map<string, GitHubAppRegistrationSecretHealthFact>();
    const registrations = new Map<string, Readonly<{
        secrets: ReturnType<typeof decryptGitHubAppRegistrationSecretsV1> | null;
        fact: GitHubAppRegistrationSecretHealthFact;
    }>>();
    for (const candidate of candidates) {
        const facts = captured.get(candidate.key);
        if (!facts) continue;
        const { installation, metadata } = facts;
        const registration = installation.registration;
        const registrationKey = JSON.stringify([registration.id, registration.securityRevision]);
        let admitted = registrations.get(registrationKey);
        if (!admitted) {
            let secrets: ReturnType<typeof decryptGitHubAppRegistrationSecretsV1> | null;
            try {
                secrets = decryptGitHubAppRegistrationSecretsV1({
                    registrationId: registration.id,
                    encryptedSecrets: Uint8Array.from(registration.encryptedSecrets),
                });
            } catch {
                secrets = null;
            }
            admitted = { secrets, fact: {
                registrationId: registration.id,
                securityRevision: registration.securityRevision,
                secretHealth: secrets === null ? null : projectGitHubAppSecretHealthV1(secrets),
            } };
            registrations.set(registrationKey, admitted);
        }
        registrationSecretHealthByKey.set(candidate.key, admitted.fact);
        const { secrets } = admitted;
        if (!secrets?.clientSecret || !secrets.privateKey) continue;
        results.set(candidate.key, {
            module: createManagedGitHubIdentityProviderModule({
                providerId: candidate.provider.id,
                callbackProviderId: MANAGED_GITHUB_APP_CALLBACK_PROVIDER_ID,
                displayName: candidate.provider.displayName,
                context: candidate.context,
                connectionId: candidate.connectionId,
                githubHost: registration.githubHost,
                githubAppId: registration.githubAppId,
                githubClientId: registration.githubClientId,
                clientSecret: secrets.clientSecret,
                privateKey: secrets.privateKey,
                githubInstallationId: installation.githubInstallationId,
                githubAppInstallationRecordId: installation.id,
                githubOrganizationId: installation.githubOrganizationId,
                githubOrganizationLogin: installation.githubOrganizationLogin,
                redirectUrl: managedGitHubAppUserAuthorizationCallbackUrl(candidate.publicServerUrl),
                networkPolicy: metadata.networkPolicy,
            }),
            runtimeFingerprint: metadata.runtimeFingerprint,
            connectionRevision: candidate.connectionRevision,
        });
    }
    return { modules: results, registrationSecretHealthByKey };
}

/** Builds the live leaves for one verified managed GitHub identity consumer. */
export function createManagedGitHubIdentityProviderModule(
    input: ManagedGitHubIdentityProviderModuleInput,
): ProviderModule {
    const getDirectoryIdentityMatch = (profile: unknown): DirectoryProvisionedIdentityMatch | null =>
        input.context.kind === "team" ? {
            kind: "github_organization",
            githubAppInstallationId: input.githubAppInstallationRecordId,
            externalUserId: String(parseManagedGitHubUserProfile(profile).id),
        } : null;
    const identity = createManagedGitHubIdentityProvider(input, getDirectoryIdentityMatch);
    return Object.freeze({
        id: input.providerId,
        oauth: Object.freeze({
            ...createManagedGitHubUserOAuthProvider({
                providerId: input.providerId,
                callbackProviderId: input.callbackProviderId,
                githubHost: input.githubHost,
                clientId: input.githubClientId,
                clientSecret: input.clientSecret,
                redirectUrl: input.redirectUrl,
                networkPolicy: input.networkPolicy,
            }),
            getDirectoryIdentityMatch,
        }),
        identity,
        auth: Object.freeze({
            id: input.providerId,
            resolveFeatures: ({ policy }: { policy: AuthPolicy }) => resolveManagedGitHubAuthProviderFeatures({
                displayName: input.displayName,
                enabled: true,
                configured: true,
            }, policy),
            requiresOAuth: true,
            isConfigured: () => true,
        }),
    });
}

function createManagedGitHubIdentityProvider(
    input: ManagedGitHubIdentityProviderModuleInput,
    getDirectoryIdentityMatch: (profile: unknown) => DirectoryProvisionedIdentityMatch | null,
): IdentityProvider {
    const organizationMembership = (profile: ReturnType<typeof parseManagedGitHubUserProfile>) =>
        verifyGitHubOrganizationMember({
            githubHost: input.githubHost,
            githubAppId: input.githubAppId,
            privateKey: input.privateKey,
            githubInstallationId: input.githubInstallationId,
            githubOrganizationLogin: input.githubOrganizationLogin,
            githubUserId: BigInt(profile.id),
            githubUserLogin: profile.login,
            networkPolicy: input.networkPolicy,
        });

    const prepareConnect: IdentityProvider["prepareConnect"] = async (params) => {
        const profile = parseManagedGitHubUserProfile(params.profile);
        const directoryMatch = getDirectoryIdentityMatch(profile);
        const membership = await organizationMembership(profile);
        if (membership.status === "unavailable") throw new Error("github_membership_unknown");
        if (membership.status !== "active") throw new Error("github_organization_mismatch");
        const preparedGroups = input.context.kind === "team" && input.connectionId !== null
            ? await prepareIdentityConnectionGroupRefresh({
                accountId: params.ctx.uid,
                teamId: input.context.teamId,
                connectionId: input.connectionId,
                observeActiveExternalGroupIds: async (githubTeamIds) => {
                    if (githubTeamIds.length === 0) return new Set<string>();
                    const observation = await readGitHubTeamMembershipObservation({
                        githubHost: input.githubHost,
                        githubAppId: input.githubAppId,
                        privateKey: input.privateKey,
                        githubInstallationId: input.githubInstallationId,
                        githubOrganizationId: input.githubOrganizationId,
                        githubUserLogin: profile.login,
                        githubTeamIds,
                        networkPolicy: input.networkPolicy,
                    });
                    return observation.status === "complete"
                        ? new Set(observation.activeTeamIds)
                        : null;
                },
            })
            : null;
        const preparedIdentity = await prepareIdentityLink({
            accountId: params.ctx.uid,
            provider: input.providerId,
            providerUserId: String(profile.id),
            providerLogin: profile.login.toLowerCase(),
            profile,
            token: null,
            presentation: {
                username: params.preferredUsername ?? profile.login,
                name: profile.name,
            },
            eligibility: {
                eligibilityStatus: "eligible",
                eligibilityReason: null,
                eligibilityCheckedAt: new Date(),
                eligibilityNextCheckAt: null,
            },
            transferFromAccountId: params.transferFromAccountId,
            usernamePolicyEnv: params.usernamePolicyEnv,
        });
        return {
            connectInTx: async (tx) => {
                await preparedIdentity.connectInTx(tx);
                if (input.context.kind === "team" && directoryMatch) {
                    await bindDirectoryProvisionedIdentitiesInTx(tx, {
                        accountId: params.ctx.uid,
                        teamId: input.context.teamId,
                        match: directoryMatch,
                    });
                }
                await preparedGroups?.applyInTx(tx);
            },
        };
    };

    return Object.freeze({
        id: input.providerId,
        prepareConnect,
        connect: async (params) => {
            const prepared = await prepareConnect(params);
            await inTx(prepared.connectInTx, { isolationLevel: "Serializable" /* Managed GitHub identity linking composes current directory/source and provider admission. */ });
        },
        disconnect: async ({ ctx }) => await unlinkIdentity({
            accountId: ctx.uid,
            provider: input.providerId,
        }),
        enforceLoginEligibility: async ({ accountId, policy, now = new Date() }) => {
            const normalizedAccountId = accountId.trim();
            if (!normalizedAccountId) return { ok: false, statusCode: 401, error: "invalid-token" };
            const stored = await db.accountIdentity.findFirst({
                where: { accountId: normalizedAccountId, provider: input.providerId },
                select: {
                    id: true,
                    profile: true,
                    eligibilityStatus: true,
                    eligibilityCheckedAt: true,
                    eligibilityNextCheckAt: true,
                },
            });
            if (!stored) {
                return { ok: false, statusCode: 403, error: "provider-required", provider: input.providerId };
            }
            const shouldCheck = policy.offboarding.enabled
                ? !stored.eligibilityNextCheckAt || stored.eligibilityNextCheckAt <= now
                : stored.eligibilityCheckedAt === null;
            if (!shouldCheck) {
                if (stored.eligibilityStatus === "eligible") return { ok: true };
                if (stored.eligibilityStatus === "ineligible") {
                    return { ok: false, statusCode: 403, error: "not-eligible" };
                }
                return { ok: false, statusCode: 503, error: "upstream_error" };
            }
            let profile: ReturnType<typeof parseManagedGitHubUserProfile>;
            try {
                profile = parseManagedGitHubUserProfile(stored.profile);
            } catch {
                return { ok: false, statusCode: 403, error: "not-eligible" };
            }
            const checked = await organizationMembership(profile);
            const nextCheckAt = policy.offboarding.enabled
                ? new Date(now.getTime() + policy.offboarding.intervalSeconds * 1000)
                : null;
            await refreshIdentity({
                accountId: normalizedAccountId,
                provider: input.providerId,
                identityId: stored.id,
                data: {
                    eligibilityStatus: checked.status === "active"
                        ? "eligible"
                        : checked.status === "unavailable" ? "unknown" : "ineligible",
                    eligibilityReason: checked.status === "active" ? null : checked.status,
                    eligibilityCheckedAt: now,
                    eligibilityNextCheckAt: nextCheckAt,
                },
            });
            if (checked.status === "active") return { ok: true };
            if (checked.status === "unavailable") return { ok: false, statusCode: 503, error: "upstream_error" };
            return { ok: false, statusCode: 403, error: "not-eligible" };
        },
        ...createManagedGitHubIdentityPresentation(input.githubHost),
    });
}
