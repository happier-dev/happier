import {
    IDENTITY_ENDPOINT_MAX_HEADER_BYTES,
    IDENTITY_ENDPOINT_MAX_RESPONSE_BYTES,
    type OutboundIdentityNetworkPolicy,
} from "@/app/net/outboundIdentityNetworkPolicy";

import type {
    DirectoryGroup,
    DirectoryGroupMember,
    DirectoryPerson,
} from "@/app/teams/directory/directorySourceEvidence";
import {
    GITHUB_REQUEST_HEADERS,
    createPurposeNarrowedGitHubInstallationOctokit,
    readGitHubAppInstallationEvidence,
} from "./githubAppInstallationClient";
import {
    readPurposeNarrowedGitHubDirectoryPage,
    type GithubDirectoryPageFailure,
    type GithubDirectoryPageResult,
} from "./githubDirectoryAdapter";

export {
    applyGitHubAppSecretReplacementV1,
    decryptGitHubAppRegistrationSecretsV1,
    encryptGitHubAppRegistrationSecretsV1,
    githubAppRegistrationSecretEncryptionPathV1,
    parseGitHubAppRegistrationConfigV1,
    parseGitHubPermissionsV1,
    projectGitHubAppSecretHealthV1,
    resolveGitHubAppConsumerReadinessV1,
    validateGitHubAppInstallationEvidenceV1,
} from "./githubManagedApp";
export type {
    GitHubAppConsumerPurposeV1,
    GitHubAppConsumerReadinessResultV1,
    GitHubAppInstallationEvidenceResultV1,
    GitHubAppInstallationEvidenceV1,
    GitHubAppRegistrationConfigV1,
    GitHubAppRegistrationSecretReplacementV1,
    GitHubAppRegistrationSecretsV1,
    GitHubPermissionsV1,
    GitHubAppSecretHealthV1,
} from "./githubManagedApp";
/**
 * Single server-owned integration owner for the deployment GitHub App
 * (Teams Lane 03 child 04 §7 / child 05 §12.1).
 *
 * This module is the only place that resolves the deployment App
 * configuration (`AUTH_GITHUB_APP_ID`, `AUTH_GITHUB_APP_PRIVATE_KEY`,
 * `AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG`) and exchanges it for
 * purpose-narrowed installation Octokit clients. Every one of those clients
 * — membership check and directory page alike — is built by the shared
 * installation-client owner on the outbound identity boundary, so this
 * module has one network policy rather than a legacy path beside a current
 * one. Raw App secrets, App clients, and Octokit instances never leave this
 * file; callers consume
 * purpose-bound operations only (currently: organization-membership,
 * directory page reads, and managed registration/installation contracts).
 *
 * The bare `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY` generic integration
 * namespace is deliberately not accepted: the authentication App must not
 * borrow generic integration credentials (see
 * `app/auth/providers/github/orgMembership.appIdentity.spec.ts`). Managed
 * registrations share this facade but never fall back to the
 * deployment configuration. Deployment installation IDs remain resolved
 * internally per organization instead of accepted from callers.
 */

type GithubAppConfig = Readonly<{
    appId: string;
    privateKey: string;
    installationsByOrg: ReadonlyMap<string, number>;
}>;

/** The deployment App is a github.com contract; its host is never operator-supplied. */
const DEPLOYMENT_GITHUB_HOST = "https://github.com";

const DEPLOYMENT_GITHUB_NETWORK_POLICY: OutboundIdentityNetworkPolicy = Object.freeze({
    address: Object.freeze({ kind: "publicOnly" as const }),
    allowedPorts: Object.freeze([443]),
    allowLoopbackHttp: false,
    maxResponseBytes: IDENTITY_ENDPOINT_MAX_RESPONSE_BYTES,
    maxHeaderBytes: IDENTITY_ENDPOINT_MAX_HEADER_BYTES,
    timeoutMs: 30_000,
});

function parseInstallationMap(raw: string | undefined): Map<string, number> {
    const out = new Map<string, number>();
    if (typeof raw !== "string") return out;
    for (const part of raw.split(/[,\s]+/g)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const [orgRaw, idRaw] = trimmed.split("=");
        const org = (orgRaw ?? "").trim().toLowerCase();
        const id = Number.parseInt((idRaw ?? "").trim(), 10);
        if (!org || !Number.isFinite(id) || id <= 0) continue;
        out.set(org, id);
    }
    return out;
}

function resolveGithubAppConfigFromEnv(env: NodeJS.ProcessEnv): GithubAppConfig | null {
    const appId = (env.AUTH_GITHUB_APP_ID ?? "").toString().trim();
    const privateKey = (env.AUTH_GITHUB_APP_PRIVATE_KEY ?? "").toString();
    const mapRaw = (env.AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG ?? "").toString().trim();
    if (!appId || !privateKey || !mapRaw) return null;

    const installationsByOrg = parseInstallationMap(mapRaw);
    if (installationsByOrg.size === 0) return null;

    return Object.freeze({
        appId,
        privateKey,
        installationsByOrg,
    });
}

function readHttpStatus(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
    return typeof error.status === "number" ? error.status : undefined;
}

/**
 * Checks one user's membership in one organization through the deployment
 * App installation for that organization (purpose: login eligibility).
 *
 * Missing deployment configuration, a missing installation for the org, and
 * a 404 from GitHub all mean "not a member" (`false`); any other upstream
 * failure is thrown so the caller can distinguish transient breakage.
 */
export async function isOrgMemberViaDeploymentApp(params: {
    org: string;
    username: string;
    env: NodeJS.ProcessEnv;
}): Promise<boolean> {
    const org = params.org.toString().trim().toLowerCase();
    const username = params.username.toString().trim();
    const config = resolveGithubAppConfigFromEnv(params.env);
    if (!config) {
        return false;
    }

    const installationId = config.installationsByOrg.get(org);
    if (!installationId) {
        return false;
    }

    // The same purpose-narrowed installation client the directory pages use.
    // A second App instance on the default global fetch would give this one
    // legacy call its own timeout, redirect and response-size behavior.
    const timeoutSignal = AbortSignal.timeout(30_000);
    const client = await createPurposeNarrowedGitHubInstallationOctokit({
        githubHost: DEPLOYMENT_GITHUB_HOST,
        githubAppId: config.appId,
        privateKey: config.privateKey,
        githubInstallationId: installationId,
        permissions: { members: "read" },
        networkPolicy: DEPLOYMENT_GITHUB_NETWORK_POLICY,
        signal: timeoutSignal,
    });
    if (!client) return false;

    try {
        // https://docs.github.com/en/rest/orgs/members#check-organization-membership-for-a-user
        await client.octokit.request("GET /orgs/{org}/members/{username}", {
            org,
            username,
            headers: GITHUB_REQUEST_HEADERS,
            request: { signal: timeoutSignal },
        });
        return true;
    } catch (error) {
        const status = readHttpStatus(error);
        if (status === 404) return false;
        throw error;
    } finally {
        await client.close();
    }
}

export type {
    GithubDirectoryReadFailureCode,
    GithubDirectoryPageFailure,
    GithubDirectoryPageSuccess,
    GithubDirectoryPageResult,
} from "./githubDirectoryAdapter";

function resolveDeploymentDirectoryInstallation(params: Readonly<{
    organizationLogin: string;
    env: NodeJS.ProcessEnv;
}>): Readonly<{
    ok: true;
    config: GithubAppConfig;
    installationId: number;
}> | GithubDirectoryPageFailure {
    const config = resolveGithubAppConfigFromEnv(params.env);
    if (!config) return { ok: false, code: "installation_unavailable" };
    const installationId = config.installationsByOrg.get(params.organizationLogin);
    if (!installationId) return { ok: false, code: "installation_unavailable" };
    return { ok: true, config, installationId };
}

/** Reads one normalized page of active organization members. */
export async function readGithubOrgMembersPage(params: {
    org: string;
    page: number;
    perPage: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}): Promise<GithubDirectoryPageResult<DirectoryPerson>> {
    const organizationLogin = params.org.toString().trim().toLowerCase();
    const resolved = resolveDeploymentDirectoryInstallation({ organizationLogin, env: params.env });
    if (!resolved.ok) return resolved;
    return await readPurposeNarrowedGitHubDirectoryPage({
        githubHost: DEPLOYMENT_GITHUB_HOST,
        githubAppId: resolved.config.appId,
        privateKey: resolved.config.privateKey,
        githubInstallationId: resolved.installationId,
        networkPolicy: DEPLOYMENT_GITHUB_NETWORK_POLICY,
        organizationLogin,
        resource: { kind: "organization_members" },
        page: params.page,
        perPage: params.perPage,
        signal: params.signal,
    });
}

/** Reads one normalized page of organization Teams. */
export async function readGithubOrgTeamsPage(params: {
    org: string;
    page: number;
    perPage: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}): Promise<GithubDirectoryPageResult<DirectoryGroup>> {
    const organizationLogin = params.org.toString().trim().toLowerCase();
    const resolved = resolveDeploymentDirectoryInstallation({ organizationLogin, env: params.env });
    if (!resolved.ok) return resolved;
    return await readPurposeNarrowedGitHubDirectoryPage({
        githubHost: DEPLOYMENT_GITHUB_HOST,
        githubAppId: resolved.config.appId,
        privateKey: resolved.config.privateKey,
        githubInstallationId: resolved.installationId,
        networkPolicy: DEPLOYMENT_GITHUB_NETWORK_POLICY,
        organizationLogin,
        resource: { kind: "organization_teams" },
        page: params.page,
        perPage: params.perPage,
        signal: params.signal,
    });
}

/** Reads one normalized page of one immutable GitHub Team's members. */
export async function readGithubTeamMembersPage(params: {
    org: string;
    teamId: number;
    page: number;
    perPage: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}): Promise<GithubDirectoryPageResult<DirectoryGroupMember>> {
    const organizationLogin = params.org.toString().trim().toLowerCase();
    const resolved = resolveDeploymentDirectoryInstallation({ organizationLogin, env: params.env });
    if (!resolved.ok) return resolved;
    let githubAppId: bigint;
    try {
        githubAppId = BigInt(resolved.config.appId);
    } catch {
        return { ok: false, code: "installation_unavailable" };
    }
    let evidence;
    try {
        evidence = await readGitHubAppInstallationEvidence({
            githubHost: DEPLOYMENT_GITHUB_HOST,
            githubAppId,
            privateKey: resolved.config.privateKey,
            githubInstallationId: BigInt(resolved.installationId),
            networkPolicy: DEPLOYMENT_GITHUB_NETWORK_POLICY,
            signal: params.signal,
        });
    } catch {
        return { ok: false, code: "upstream_unavailable" };
    }
    if (!evidence || evidence.githubOrganizationLogin.trim().toLowerCase() !== organizationLogin) {
        return { ok: false, code: "installation_unavailable" };
    }
    const organizationId = Number(evidence.githubOrganizationId);
    if (!Number.isSafeInteger(organizationId)) return { ok: false, code: "installation_unavailable" };
    return await readPurposeNarrowedGitHubDirectoryPage({
        githubHost: DEPLOYMENT_GITHUB_HOST,
        githubAppId: resolved.config.appId,
        privateKey: resolved.config.privateKey,
        githubInstallationId: resolved.installationId,
        networkPolicy: DEPLOYMENT_GITHUB_NETWORK_POLICY,
        organizationLogin,
        organizationId,
        resource: { kind: "team_members", githubTeamId: params.teamId },
        page: params.page,
        perPage: params.perPage,
        signal: params.signal,
    });
}
