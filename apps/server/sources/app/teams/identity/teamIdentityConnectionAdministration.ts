import type {
    TeamIdentityConnectionCreateInputV1,
    IdentityEligibleProviderV1,
    TeamAdmissionModeApplicabilityV1,
    TeamIdentityConnectionRefInputV1,
    TeamIdentityConnectionSettingsUpdateInputV1,
    TeamIdentityConnectionRemoveResultV1,
    TeamIdentityConnectionRemovalBlockerV1,
    IdentityConnectionRemovalPreflightV1,
    TeamIdentityConnectionTestConsumeInputV1,
    IdentityConnectionTestConsumeResultV1,
    TeamIdentityConnectionTestStartInputV1,
    TeamIdentityConnectionTestStartResultV1,
    IdentityConnectionV1,
    TeamIdentityErrorCodeV1,
} from "@happier-dev/protocol/teams";
import { isDeepStrictEqual } from "node:util";

import { consumeIdentityConnectionTestResultInTx } from "@/app/api/routes/connect/oauthExternal/identityConnectionTestResult";
import { createExternalAuthorizeAttempt } from "@/app/api/routes/connect/oauthExternal/createExternalAuthorizeUrl";
import {
    resolveOAuthRuntimeById,
    resolveRuntimeInTx,
    listEligibleTeamIdentityProvidersInTx,
} from "@/app/auth/providers/identityProviderCatalog";
import {
    checkAccountRetainsLoginRouteForDecisions,
    readAccountLoginViabilityFactsByAccountIdAfterProviderRemovalInTx,
    resolveEffectiveAccountLoginMethodsForDecisions,
} from "@/app/auth/methods/effectiveAccountLoginMethods";
import { resolveEffectiveHomeAuthMethodsInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveTeamAuthenticationPolicy, resolveTeamAuthenticationPolicyInTx } from "@/app/auth/entry/resolveTeamAuthenticationPolicy";
import { normalizeAuthMethodId } from "@happier-dev/protocol";
import { findIdentityProviderBlockers } from "@/app/auth/providers/accountIdentityLifecycle";
import {
    readIdentityProviderInstanceInTx,
    setIdentityProviderInstanceEnabledInTx,
} from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import { resolveManagedGitHubIdentityProviderConnectionDraftInTx } from "@/app/integrations/github/githubManagedIdentityProvider";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import {
    resolveWorkosPlatformConfig,
    resolveWorkosPlatformRequestPolicy,
    type WorkosPlatformConfigResolution,
    type WorkosPlatformRequestPolicy,
} from "@/app/integrations/workos/workosPlatform";
import { createWorkosAdministrationAdapter } from "@/app/integrations/workos/workosAdministrationAdapter";
import {
    readHomeGovernancePolicyInTx,
    resolveTeamProviderKindPolicy,
} from "@/app/home/governance/governancePolicy";
import { inTx, type Tx } from "@/storage/inTx";
import {
    createTeamIdentityConnectionInTx,
    deleteTeamIdentityConnectionInTx,
    listTeamIdentityConnectionsInTx,
    readTeamIdentityConnectionInTx,
    recordTeamIdentityConnectionTestInTx,
    removeTeamWorkosSsoConfigurationInTx,
    setTeamIdentityConnectionEnabledInTx,
    updateTeamIdentityConnectionInTx,
    recordTeamIdentityConnectionWorkosObservationInTx,
} from "./teamIdentityConnectionLifecycle";
import type { TeamIdentityConnectionView as LifecycleConnectionView } from "./teamIdentityConnectionLifecycle";
import { isSameProviderContext } from "@/app/auth/providers/providerReference";
import { publishCommittedHomeProviderMutationInTx } from "@/app/home/governance/homeManagedIdentityProviders";
import type { TeamOperationAuthenticationContext } from "../actorContext";
import { authorizeTeamIdentityAdministrationInTx, identityConnectionOwner } from "./teamIdentityAdministrationAuthority";
import {
    projectCurrentTeamIdentityConnectionV1InTx,
    readTeamIdentityCurrentnessInputsInTx,
} from "./teamIdentityConnectionProjection";
import { resolveTeamIdentityConnectionReturnUrl } from "./teamIdentityConnectionUrls";

import { resolveTeamAdmissionModeApplicabilityInTx } from "./teamAdmissionModeApplicability";
import type { WorkosAdministrationDependencies } from "./teamWorkosAdministration";

type TeamIdentityConnectionView = LifecycleConnectionView<string | null>;
type ScopedInput<T> = Omit<T, "teamId"> & Readonly<{ teamId: string | null }>;

type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: TeamIdentityErrorCodeV1 }>;

class TeamIdentityConnectionCreateAbort extends Error {
    constructor(readonly code: TeamIdentityErrorCodeV1) {
        super(code);
    }
}

export async function preflightTeamIdentityConnectionRemovalForActor(
    input: ScopedInput<TeamIdentityConnectionRefInputV1> & Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        env: NodeJS.ProcessEnv;
    }>,
): Promise<Result<IdentityConnectionRemovalPreflightV1>> {
    return await inTx(async (tx) => await resolveTeamIdentityConnectionRemovalPreflightInTx(tx, input));
}

async function resolveTeamIdentityConnectionRemovalPreflightInTx(
    tx: Tx,
    input: ScopedInput<TeamIdentityConnectionRefInputV1> & Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        env: NodeJS.ProcessEnv;
    }>,
): Promise<Result<IdentityConnectionRemovalPreflightV1>> {
    const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
    if (!authority.ok) return authority;
    const resolved = await readTeamIdentityConnectionInTx(tx, {
        id: input.connectionId,
        teamId: input.teamId,
    });
    if (resolved.status === "not_found") {
        return { ok: false, error: "identity_connection_not_found" };
    }
    if (resolved.status !== "ready") {
        return { ok: false, error: "identity_connection_invalid" };
    }
    if (resolved.connection.revision !== input.expectedRevision) {
        return { ok: false, error: "identity_connection_conflict" };
    }

    const [team, identityRows, directorySources, externalGroupBindings, managedMemberships, effectiveHome] = await Promise.all([
        input.teamId === null ? Promise.resolve(null) : tx.team.findUnique({ where: { id: input.teamId }, select: { authenticationPolicy: true } }),
        findIdentityProviderBlockers(tx, resolved.connection.providerInstanceId),
        tx.teamDirectorySource.count({ where: { teamIdentityConnectionId: input.connectionId } }),
        tx.teamExternalGroupBinding.count({ where: { teamIdentityConnectionId: input.connectionId } }),
        tx.teamMembershipIdentityConnectionManagement.count({ where: { teamIdentityConnectionId: input.connectionId } }),
        resolveEffectiveHomeAuthMethodsInTx(tx, { env: input.env }),
    ]);
    if (input.teamId !== null && !team) return { ok: false, error: "team_not_found" };

    const policy = input.teamId !== null && team ? await resolveTeamAuthenticationPolicyInTx(tx, {
        env: input.env,
        teamId: input.teamId,
        policy: team.authenticationPolicy,
    }) : null;
    const blockers: TeamIdentityConnectionRemovalBlockerV1[] = [];
    const siblingBindings = await tx.teamIdentityConnection.count({ where: {
        providerInstanceId: resolved.connection.providerInstanceId,
        id: { not: input.connectionId },
    } });
    if (siblingBindings > 0) blockers.push("identity_connection_in_use");
    if (input.teamId === null) {
        const teams = await tx.team.findMany({ select: { authenticationPolicy: true } });
        const providerId = normalizeAuthMethodId(resolved.connection.providerInstanceId);
        if (teams.some((candidate) => {
            const accepted = resolveTeamAuthenticationPolicy({ policy: candidate.authenticationPolicy, homeMethods: [], teamConnections: [] });
            return accepted.status === "restricted" && accepted.choices.some((choice) =>
                choice.reference.kind === "home_method" && normalizeAuthMethodId(choice.reference.methodId) === providerId);
        })) blockers.push("team_authentication_policy_in_use");
    }
    if (policy?.resolution.status === "unavailable") {
        blockers.push("team_authentication_policy_unavailable");
    } else if (
        policy?.resolution.status === "restricted"
        && policy.resolution.choices.some((choice) =>
            choice.reference.kind === "team_connection"
            && choice.reference.connectionId === input.connectionId)
    ) {
        if (!blockers.includes("team_authentication_policy_in_use")) blockers.push("team_authentication_policy_in_use");
    }

    const accountIds = [...new Set(identityRows.map((row) => row.accountId))];
    let accountsRequiringAlternateLogin = 0;
    if (accountIds.length > 0 && effectiveHome.status !== "ready") {
        blockers.push("home_authentication_policy_unavailable");
    } else if (effectiveHome.status === "ready") {
        const [currentFactsByAccountId, remainingFactsByAccountId] = await Promise.all([
            readAccountLoginViabilityFactsByAccountIdAfterProviderRemovalInTx(tx, {
                accountIds,
                env: input.env,
                excludedProviderId: null,
                identityEligibility: "current",
            }),
            readAccountLoginViabilityFactsByAccountIdAfterProviderRemovalInTx(tx, {
                accountIds,
                env: input.env,
                excludedProviderId: resolved.connection.providerInstanceId,
                identityEligibility: "current",
            }),
        ]);
        for (const accountId of accountIds) {
            const currentFacts = currentFactsByAccountId.get(accountId);
            const remainingFacts = remainingFactsByAccountId.get(accountId);
            if (!currentFacts || !remainingFacts) continue;
            const currentlyViable = resolveEffectiveAccountLoginMethodsForDecisions(
                effectiveHome.decisions,
                currentFacts,
            ).viable;
            if (
                currentlyViable
                && !checkAccountRetainsLoginRouteForDecisions(
                    effectiveHome.decisions,
                    remainingFacts,
                ).ok
            ) accountsRequiringAlternateLogin += 1;
        }
        if (accountsRequiringAlternateLogin > 0) {
            blockers.push("account_would_lose_login");
        }
    }
    if (resolved.connection.providerKind !== "workos_sso") {
        if (directorySources > 0) blockers.push("directory_source_in_use");
        if (externalGroupBindings > 0) blockers.push("external_group_binding_in_use");
    }
    if (managedMemberships > 0) blockers.push("managed_membership_in_use");

    return {
        ok: true,
        value: {
            v: 1,
            canRemove: blockers.length === 0,
            connection: await projectCurrentTeamIdentityConnectionV1InTx(tx, { env: input.env, teamId: input.teamId, connection: resolved.connection }),
            impact: {
                linkedAccounts: accountIds.length,
                accountsRequiringAlternateLogin,
                directorySources,
                externalGroupBindings,
                managedMemberships,
            },
            blockers,
        },
    };
}

export async function startTeamIdentityConnectionTestForActor(
    input: ScopedInput<TeamIdentityConnectionTestStartInputV1> & Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        env: NodeJS.ProcessEnv;
    }>,
): Promise<Result<TeamIdentityConnectionTestStartResultV1>> {
    const preflight = await inTx(async (tx) => {
        const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
        if (!authority.ok) return authority;
        const result = await readTeamIdentityConnectionInTx(tx, {
            id: input.connectionId,
            teamId: input.teamId,
        });
        if (result.status === "not_found") {
            return { ok: false as const, error: "identity_connection_not_found" as const };
        }
        if (result.status !== "ready") {
            return { ok: false as const, error: "identity_connection_invalid" as const };
        }
        if (result.connection.revision !== input.expectedRevision) {
            return { ok: false as const, error: "identity_connection_conflict" as const };
        }
        if (
            result.connection.externalReference.kind === "workos_sso"
            && result.connection.externalReference.connectionId === null
        ) {
            return { ok: false as const, error: "identity_connection_invalid" as const };
        }
        return { ok: true as const, connection: result.connection };
    });
    if (!preflight.ok) return preflight;

    const runtime = await resolveOAuthRuntimeById(
        input.env,
        preflight.connection.providerInstanceId,
        identityConnectionOwner(input.teamId),
        "identity_connection_test",
    );
    if (!runtime) return { ok: false, error: "identity_provider_unavailable" };
    try {
        await runtime.provider.validateConfiguration?.({ env: input.env });
        const homeServerIdentityId = await getOrCreateServerIdentityId(input.env);
        const returnUrl = resolveTeamIdentityConnectionReturnUrl({
            env: input.env,
            homeServerIdentityId,
            teamId: input.teamId,
            connectionId: input.connectionId,
        });
        if (!returnUrl) return { ok: false, error: "identity_connection_invalid" };
        const attempt = await createExternalAuthorizeAttempt({
            flow: "connect",
            providerId: runtime.reference.id,
            provider: runtime.provider,
            reference: runtime.reference,
            env: input.env,
            userId: input.actorAccountId,
            purpose: "identity_connection_test",
            connection: {
                id: input.connectionId,
                revision: input.expectedRevision,
            },
            webAppOAuthReturnUrl: returnUrl,
        });
        return attempt
            ? { ok: true, value: { authorizeUrl: attempt.url, attemptId: attempt.attemptId } }
            : { ok: false, error: "identity_connection_test_invalid" };
    } catch {
        return { ok: false, error: "identity_provider_unavailable" };
    }
}

/**
 * The Team Authentication overview minus its member sign-in link.
 *
 * The link is composed from the Home's configured application origin and the
 * portable connection carrier, neither of which this transactional service can
 * see. Its route resolves them through the same owner the invitation link uses
 * and completes the wire result there, so there is one link renderer rather
 * than a second origin decision inside the identity transaction.
 */
export type TeamIdentityConnectionListProjectionV1 = Readonly<{
    items: IdentityConnectionV1[];
    eligibleProviders: IdentityEligibleProviderV1[];
    admissionModeApplicability?: TeamAdmissionModeApplicabilityV1;
}>;

export async function listTeamIdentityConnectionsForActor(
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{ teamId: string | null; actorAccountId: string; env: NodeJS.ProcessEnv }>,
): Promise<Result<TeamIdentityConnectionListProjectionV1>> {
    return await inTx(async (tx) => {
        const authority = await authorizeTeamIdentityAdministrationInTx(tx, input, "view");
        if (!authority.ok) return authority;
        const connections = await listTeamIdentityConnectionsInTx(tx, input);
        const inputs = await readTeamIdentityCurrentnessInputsInTx(tx, { env: input.env, teamId: input.teamId });
        const projectedItems = await Promise.all(connections.map((connection) => projectCurrentTeamIdentityConnectionV1InTx(tx, {
            env: input.env,
            teamId: input.teamId,
            connection,
            inputs,
        })));
        const items = authority.canMutate ? projectedItems : projectedItems.map((item) => ({ ...item, allowedActions: [] }));
        const [eligibleProviders, admissionModeApplicability] = await Promise.all([
            authority.canMutate ? listEligibleTeamIdentityProvidersInTx(tx, {
                env: input.env,
                teamId: input.teamId,
                connectedProviderInstanceIds: new Set(connections.map((connection) => connection.providerInstanceId)),
            }) : Promise.resolve([]),
            input.teamId === null ? Promise.resolve(null) : resolveTeamAdmissionModeApplicabilityInTx({ tx, env: input.env, teamId: input.teamId }),
        ]);
        return {
            ok: true,
            value: { items, eligibleProviders: [...eligibleProviders], ...(admissionModeApplicability ? { admissionModeApplicability } : {}) },
        };
    });
}

export async function createTeamIdentityConnectionForActor(
    input: ScopedInput<TeamIdentityConnectionCreateInputV1> & Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        env: NodeJS.ProcessEnv;
    }>,
): Promise<Result<IdentityConnectionV1>> {
    try {
        return await inTx(async (tx) => {
            const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
            if (!authority.ok) return authority;
            const home = await readHomeGovernancePolicyInTx(tx);
            const policy = resolveTeamProviderKindPolicy(home, input.externalReference.kind);
            if (policy !== "allowed") return { ok: false, error: "identity_provider_unavailable" };
            const teamProvider = await readIdentityProviderInstanceInTx(tx, {
                id: input.providerInstanceId,
                owner: identityConnectionOwner(input.teamId),
        });
            const disabledTeamGitHubProvider = teamProvider.status === "ready"
                && teamProvider.instance.kind === "github_app_identity"
                && !teamProvider.instance.enabled
                ? teamProvider.instance
                : null;
            if (disabledTeamGitHubProvider) {
                const draft = await resolveManagedGitHubIdentityProviderConnectionDraftInTx(tx, {
                    env: input.env,
                    context: identityConnectionOwner(input.teamId),
                    provider: disabledTeamGitHubProvider,
                });
                if (!draft) return { ok: false, error: "identity_provider_unavailable" };
                if (
                    !isDeepStrictEqual(input.externalReference, draft.externalReference)
                    || !isDeepStrictEqual(input.settings, draft.settings)
                ) return { ok: false, error: "identity_connection_invalid" };
                const enabled = await setIdentityProviderInstanceEnabledInTx(tx, {
                    id: disabledTeamGitHubProvider.id,
                    owner: disabledTeamGitHubProvider.owner,
                    expectedRevision: disabledTeamGitHubProvider.revision,
                    expectedSecurityRevision: disabledTeamGitHubProvider.securityRevision,
                    enabled: true,
                });
                if (enabled.status !== "applied") {
                    throw new TeamIdentityConnectionCreateAbort("identity_provider_unavailable");
                }
            }
            const result = await createTeamIdentityConnectionInTx(tx, {
                teamId: input.teamId,
                providerInstanceId: input.providerInstanceId,
                externalReference: input.externalReference,
                settings: input.settings,
                createdByAccountId: input.actorAccountId,
            });
            if (result.status === "created") {
                let connection = result.connection;
                if (disabledTeamGitHubProvider) {
                    const current = await readTeamIdentityConnectionInTx(tx, {
                        id: result.connection.id,
                        teamId: input.teamId,
                    });
                    if (current.status !== "ready") {
                        throw new TeamIdentityConnectionCreateAbort("identity_connection_invalid");
                    }
                    connection = current.connection;
                }
                await publishCommittedHomeProviderMutationInTx(tx, identityConnectionOwner(input.teamId), connection.providerInstanceId, true, {
                    actorAccountId: input.actorAccountId, action: "identity_provider.update",
                });
                return { ok: true, value: await projectCurrentTeamIdentityConnectionV1InTx(tx, { env: input.env, teamId: input.teamId, connection }) };
            }
            if (
                result.status === "already_exists"
                && result.connection
                && isDeepStrictEqual(result.connection.externalReference, input.externalReference)
                && isDeepStrictEqual(result.connection.settings, input.settings)
            ) {
                return { ok: true, value: await projectCurrentTeamIdentityConnectionV1InTx(tx, { env: input.env, teamId: input.teamId, connection: result.connection }) };
            }
            throw new TeamIdentityConnectionCreateAbort(
                result.status === "already_exists"
                    ? "identity_connection_conflict"
                    : result.status === "provider_not_available"
                        ? "identity_provider_unavailable"
                        : "identity_connection_invalid",
            );
        });
    } catch (error) {
        if (error instanceof TeamIdentityConnectionCreateAbort) return { ok: false, error: error.code };
        throw error;
    }
}

export async function updateTeamIdentityConnectionSettingsForActor(
    input: ScopedInput<TeamIdentityConnectionSettingsUpdateInputV1> & Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        env: NodeJS.ProcessEnv;
    }>,
): Promise<Result<IdentityConnectionV1>> {
    return await inTx(async (tx) => {
        const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
        if (!authority.ok) return authority;
        const result = await updateTeamIdentityConnectionInTx(tx, {
            id: input.connectionId,
            teamId: input.teamId,
            expectedRevision: input.expectedRevision,
            settings: input.settings,
        });
        if (result.status !== "applied") return { ok: false, error: mapLifecycleError(result.status) };
        await publishCommittedHomeProviderMutationInTx(tx, identityConnectionOwner(input.teamId), result.connection.providerInstanceId, true, {
            actorAccountId: input.actorAccountId, action: "identity_provider.update",
        });
        return { ok: true, value: await projectCurrentTeamIdentityConnectionV1InTx(tx, { env: input.env, teamId: input.teamId, connection: result.connection }) };
    });
}

type WorkosUpstreamObservation =
    | Readonly<{ kind: "not_applicable" }>
    | Readonly<{
        kind: "observed";
        active: boolean;
        presentation: Readonly<{ displayName: string; strategy: string; status: string; lastCheckedAt: Date }>;
    }>
    | Readonly<{ kind: "failed"; error: TeamIdentityErrorCodeV1 }>;

/**
 * Re-enable revalidates the exact upstream WorkOS connection before a new flow
 * is admitted. The binding is immutable, so a connection that was deactivated
 * or deleted in WorkOS while the row was disabled must land on
 * `needs_attention` for the administrator now, not on a failed callback for
 * every member later.
 */
async function observeWorkosUpstreamConnection(
    connection: TeamIdentityConnectionView,
    env: NodeJS.ProcessEnv,
    dependencies: WorkosAdministrationDependencies,
): Promise<WorkosUpstreamObservation> {
    if (connection.providerKind !== "workos_sso" || connection.externalReference.kind !== "workos_sso") {
        return { kind: "not_applicable" };
    }
    const { organizationId, connectionId } = connection.externalReference;
    if (organizationId === null || connectionId === null) return { kind: "not_applicable" };
    const requestPolicy = resolveWorkosPlatformRequestPolicy();
    const platform = dependencies.resolvePlatform
        ? dependencies.resolvePlatform(env, requestPolicy)
        : resolveWorkosPlatformConfig(env, {}, requestPolicy);
    if (!platform.available) return { kind: "failed", error: "workos_platform_unavailable" };
    try {
        const candidate = await createWorkosAdministrationAdapter(platform.client).getSsoConnection({
            organizationId,
            connectionId,
        });
        return {
            kind: "observed",
            active: candidate.status.toLowerCase() === "active",
            presentation: {
                displayName: candidate.displayName,
                strategy: candidate.strategy,
                status: candidate.status,
                lastCheckedAt: (dependencies.now ?? (() => new Date()))(),
            },
        };
    } catch (error) {
        return {
            kind: "failed",
            error: error instanceof Error && error.message === "workos_organization_mismatch"
                ? "workos_organization_mismatch"
                : "identity_provider_unavailable",
        };
    }
}

export async function setTeamIdentityConnectionEnabledForActor(
    input: ScopedInput<TeamIdentityConnectionRefInputV1> & Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        enabled: boolean;
        env: NodeJS.ProcessEnv;
    }>,
    dependencies: WorkosAdministrationDependencies = {},
): Promise<Result<IdentityConnectionV1>> {
    if (input.enabled) {
        const preflight = await inTx(async (tx) => {
            const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
            if (!authority.ok) return authority;
            const resolved = await readTeamIdentityConnectionInTx(tx, {
                id: input.connectionId,
                teamId: input.teamId,
            });
            if (resolved.status === "not_found") {
                return { ok: false as const, error: "identity_connection_not_found" as const };
            }
            if (resolved.status !== "ready") {
                return { ok: false as const, error: "identity_connection_invalid" as const };
            }
            if (resolved.connection.revision !== input.expectedRevision) {
                return { ok: false as const, error: "identity_connection_conflict" as const };
            }
            return { ok: true as const, connection: resolved.connection };
        });
        if (!preflight.ok) return preflight;

        const runtime = await resolveOAuthRuntimeById(
            input.env,
            preflight.connection.providerInstanceId,
            identityConnectionOwner(input.teamId),
            "identity_connection_test",
        );
        if (!runtime) return { ok: false, error: "identity_provider_unavailable" };
        try {
            await runtime.provider.validateConfiguration?.({ env: input.env });
        } catch {
            return { ok: false, error: "identity_provider_unavailable" };
        }
        const upstream = await observeWorkosUpstreamConnection(preflight.connection, input.env, dependencies);
        if (upstream.kind === "failed") return { ok: false, error: upstream.error };

        return await inTx(async (tx) => {
            const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
            if (!authority.ok) return authority;
            let expectedRevision = input.expectedRevision;
            if (upstream.kind === "observed") {
                // The observation is retained even when it refuses the enable:
                // that is what puts the row on `needs_attention` with the
                // upstream evidence the administrator needs.
                const observed = await recordTeamIdentityConnectionWorkosObservationInTx(tx, {
                    id: input.connectionId,
                    teamId: input.teamId,
                    expectedRevision,
                    presentation: upstream.presentation,
                });
                if (observed.status !== "applied") return { ok: false, error: mapLifecycleError(observed.status) };
                await publishCommittedHomeProviderMutationInTx(tx, identityConnectionOwner(input.teamId), observed.connection.providerInstanceId, true, null);
                if (!upstream.active) return { ok: false, error: "workos_connection_mismatch" };
                expectedRevision = observed.connection.revision;
            }
            const currentRuntime = await resolveRuntimeInTx(tx, {
                env: input.env,
                reference: runtime.reference,
                purpose: "identity_connection_test",
            });
            if (!currentRuntime.ok) {
                return { ok: false, error: "identity_provider_unavailable" };
            }
            const result = await setTeamIdentityConnectionEnabledInTx(tx, {
                id: input.connectionId,
                teamId: input.teamId,
                expectedRevision,
                enabled: true,
            });
            if (result.status !== "applied") return { ok: false, error: mapLifecycleError(result.status) };
            await publishCommittedHomeProviderMutationInTx(tx, identityConnectionOwner(input.teamId), result.connection.providerInstanceId, true, {
                actorAccountId: input.actorAccountId, action: "identity_provider.enable",
            });
            return { ok: true, value: await projectCurrentTeamIdentityConnectionV1InTx(tx, { env: input.env, teamId: input.teamId, connection: result.connection }) };
        });
    }

    return await inTx(async (tx) => {
        const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
        if (!authority.ok) return authority;
        const result = await setTeamIdentityConnectionEnabledInTx(tx, {
            id: input.connectionId,
            teamId: input.teamId,
            expectedRevision: input.expectedRevision,
            enabled: input.enabled,
        });
        if (result.status === "applied") {
            await publishCommittedHomeProviderMutationInTx(tx, identityConnectionOwner(input.teamId), result.connection.providerInstanceId, true, {
                actorAccountId: input.actorAccountId, action: "identity_provider.disable",
            });
            return { ok: true, value: await projectCurrentTeamIdentityConnectionV1InTx(tx, { env: input.env, teamId: input.teamId, connection: result.connection }) };
        }
        return { ok: false, error: mapLifecycleError(result.status) };
    });
}

export async function removeTeamIdentityConnectionForActor(
    input: ScopedInput<TeamIdentityConnectionRefInputV1> & Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        env: NodeJS.ProcessEnv;
    }>,
    dependencies: Readonly<{
        resolvePlatform?: (
            env: NodeJS.ProcessEnv,
            requestPolicy: WorkosPlatformRequestPolicy,
        ) => WorkosPlatformConfigResolution;
    }> = {},
): Promise<Result<TeamIdentityConnectionRemoveResultV1>> {
    type RemovalPreparation =
        | Readonly<{ ok: false; error: TeamIdentityErrorCodeV1 }>
        | Readonly<{
            ok: true;
            kind: "complete";
            value: TeamIdentityConnectionRemoveResultV1;
        }>
        | Readonly<{
            ok: true;
            kind: "workos";
            connection: IdentityConnectionV1;
        }>;
    const prepared = await inTx<RemovalPreparation>(async (tx) => {
        const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
        if (!authority.ok) return authority;
        const current = await readTeamIdentityConnectionInTx(tx, {
            id: input.connectionId,
            teamId: input.teamId,
        });
        if (current.status === "not_found") {
            return {
                ok: true,
                kind: "complete",
                value: { outcome: "already_absent" },
            };
        }
        if (
            current.status === "ready"
            && current.connection.externalReference.kind === "workos_sso"
            && current.connection.externalReference.connectionId === null
        ) {
            const retainedConsumers = await Promise.all([
                tx.teamDirectorySource.count({ where: { teamIdentityConnectionId: input.connectionId } }),
                tx.teamExternalGroupBinding.count({ where: { teamIdentityConnectionId: input.connectionId } }),
            ]);
            if (retainedConsumers.some((count) => count > 0)) {
                return {
                    ok: true,
                    kind: "complete",
                    value: { outcome: "already_absent" },
                };
            }
        }
        const preflight = await resolveTeamIdentityConnectionRemovalPreflightInTx(tx, input);
        if (!preflight.ok) return preflight;
        if (!preflight.value.canRemove) {
            return { ok: false, error: "identity_provider_in_use" };
        }
        const connection = preflight.value.connection;
        if (connection.provider.kind === "workos_sso" && connection.externalReference.kind === "workos_sso") {
            if (!connection.enabled) {
                return {
                    ok: true as const,
                    kind: "workos" as const,
                    connection,
                };
            }
            const disabled = await setTeamIdentityConnectionEnabledInTx(tx, {
                id: input.connectionId,
                teamId: input.teamId,
                expectedRevision: input.expectedRevision,
                enabled: false,
            });
            if (disabled.status !== "applied") {
                return { ok: false as const, error: mapLifecycleError(disabled.status) };
            }
            await publishCommittedHomeProviderMutationInTx(tx, identityConnectionOwner(input.teamId), disabled.connection.providerInstanceId, true, {
                actorAccountId: input.actorAccountId, action: "identity_provider.disable",
            });
            return {
                ok: true as const,
                kind: "workos" as const,
                connection: await projectCurrentTeamIdentityConnectionV1InTx(tx, { env: input.env, teamId: input.teamId, connection: disabled.connection }),
            };
        }
        const result = await deleteTeamIdentityConnectionInTx(tx, {
            id: input.connectionId,
            teamId: input.teamId,
            expectedRevision: input.expectedRevision,
        });
        if (result.status === "deleted") {
            await publishCommittedHomeProviderMutationInTx(tx, identityConnectionOwner(input.teamId), connection.provider.id, true, {
                actorAccountId: input.actorAccountId, action: "identity_provider.remove", displayName: connection.provider.displayName,
            });
            return { ok: true as const, kind: "complete" as const, value: { outcome: "removed" as const } };
        }
        if (result.status === "not_found") {
            return { ok: true as const, kind: "complete" as const, value: { outcome: "already_absent" as const } };
        }
        if (result.status === "blocked") return { ok: false as const, error: "identity_provider_in_use" as const };
        return { ok: false as const, error: mapLifecycleError(result.status) };
    });
    if (!prepared.ok) return prepared;
    if (prepared.kind === "complete") return { ok: true, value: prepared.value };

    const externalReference = prepared.connection.externalReference;
    if (externalReference.kind !== "workos_sso") {
        return { ok: false, error: "identity_connection_invalid" };
    }
    if (externalReference.connectionId !== null) {
        if (externalReference.organizationId === null) {
            return { ok: false, error: "identity_connection_invalid" };
        }
        const requestPolicy = resolveWorkosPlatformRequestPolicy();
        const platform = dependencies.resolvePlatform
            ? dependencies.resolvePlatform(input.env, requestPolicy)
            : resolveWorkosPlatformConfig(input.env, {}, requestPolicy);
        if (!platform.available) return { ok: false, error: "workos_platform_unavailable" };
        try {
            await createWorkosAdministrationAdapter(platform.client).deleteSsoConnection({
                organizationId: externalReference.organizationId,
                connectionId: externalReference.connectionId,
            });
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error && error.message === "workos_organization_mismatch"
                    ? "workos_organization_mismatch"
                    : "identity_provider_unavailable",
            };
        }
    }

    return await inTx(async (tx) => {
        const preflight = await resolveTeamIdentityConnectionRemovalPreflightInTx(tx, {
            ...input,
            expectedRevision: prepared.connection.revision,
        });
        if (!preflight.ok) return preflight;
        if (!preflight.value.canRemove) return { ok: false, error: "identity_provider_in_use" };
        const removed = await removeTeamWorkosSsoConfigurationInTx(tx, {
            id: input.connectionId,
            teamId: input.teamId,
            expectedRevision: prepared.connection.revision,
            organizationId: externalReference.organizationId,
            connectionId: externalReference.connectionId,
        });
        if (removed.status === "removed") {
            await publishCommittedHomeProviderMutationInTx(tx, identityConnectionOwner(input.teamId), prepared.connection.provider.id, true, {
                actorAccountId: input.actorAccountId, action: "identity_provider.remove", displayName: prepared.connection.provider.displayName,
            });
            return { ok: true, value: { outcome: "removed" } };
        }
        if (removed.status === "not_found") return { ok: true, value: { outcome: "already_absent" } };
        return { ok: false, error: mapLifecycleError(removed.status) };
    });
}

export async function consumeTeamIdentityConnectionTestForActor(
    input: ScopedInput<TeamIdentityConnectionTestConsumeInputV1> & Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        env: NodeJS.ProcessEnv;
    }>,
): Promise<Result<IdentityConnectionTestConsumeResultV1>> {
    return await inTx(async (tx) => {
        const authority = await authorizeTeamIdentityAdministrationInTx(tx, input);
        if (!authority.ok) return authority;
        const result = await consumeIdentityConnectionTestResultInTx(tx, {
            resultHandle: input.resultHandle,
            initiatorAccountId: input.actorAccountId,
        });
        if (!result) return { ok: false, error: "identity_connection_test_invalid" };
        const binding = result.securityBinding;
        if (
            !isSameProviderContext(binding.provider.context, identityConnectionOwner(input.teamId))
            || binding.connection?.id !== input.connectionId
        ) return { ok: false, error: "identity_connection_test_invalid" };
        const connectionBinding = binding.connection;
        if (!connectionBinding) return { ok: false, error: "identity_connection_test_invalid" };
        const connection = await readTeamIdentityConnectionInTx(tx, {
            id: input.connectionId,
            teamId: input.teamId,
        });
        if (
            connection.status !== "ready"
            || connection.connection.revision !== connectionBinding.revision
            || connection.connection.providerInstanceId !== binding.provider.id
        ) return { ok: false, error: "identity_connection_test_invalid" };
        const runtime = await resolveRuntimeInTx(tx, {
            env: input.env,
            reference: binding.provider,
            purpose: "identity_connection_test",
        });
        if (!runtime.ok) return { ok: false, error: "identity_connection_test_invalid" };
        const recorded = await recordTeamIdentityConnectionTestInTx(tx, {
            id: input.connectionId,
            teamId: input.teamId,
            expectedRevision: connectionBinding.revision,
            runtimeFingerprint: binding.provider.runtimeFingerprint,
            testedAt: result.testedAt,
        });
        if (recorded.status === "applied") {
            await publishCommittedHomeProviderMutationInTx(tx, identityConnectionOwner(input.teamId), recorded.connection.providerInstanceId, true, null);
            return {
                ok: true,
                value: {
                    connection: await projectCurrentTeamIdentityConnectionV1InTx(tx, {
                        env: input.env,
                        teamId: input.teamId,
                        connection: recorded.connection,
                    }),
                    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
                },
            };
        }
        return { ok: false, error: "identity_connection_test_invalid" };
    });
}

function mapLifecycleError(status: string): TeamIdentityErrorCodeV1 {
    switch (status) {
        case "not_found": return "identity_connection_not_found";
        case "revision_conflict": return "identity_connection_conflict";
        case "policy_in_use": return "identity_connection_policy_in_use";
        case "authentication_policy_unavailable": return "team_authentication_policy_unavailable";
        case "provider_not_available": return "identity_provider_unavailable";
        default: return "identity_connection_invalid";
    }
}
