import type { OidcProviderConfig } from "@/app/auth/providers/managed/identityProviderDocuments";
import {
    createIdentityProviderInstanceInTx,
    acquireIdentityProviderMutationAdmissionInTx,
    deleteIdentityProviderInstanceInTx,
    listIdentityProviderInstancesInTx,
    preflightDeleteIdentityProviderInstanceInTx,
    readIdentityProviderInstanceInTx,
    recordIdentityProviderInstanceSuccessfulTestInTx,
    replaceIdentityProviderSecretsInTx,
    setIdentityProviderInstanceEnabledInTx,
    updateIdentityProviderInstanceInTx,
} from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import {
    resolveOAuthRuntimeByIdInTx,
    resolveRuntimeInTx,
} from "@/app/auth/providers/identityProviderCatalog";
import {
    HOME_PROVIDER_CONTEXT,
    isSameProviderContext,
    type ProviderCatalogContext,
    type ProviderReference,
} from "@/app/auth/providers/providerReference";
import { createExternalAuthorizeAttempt } from "@/app/api/routes/connect/oauthExternal/createExternalAuthorizeUrl";
import { consumeIdentityConnectionTestResultInTx } from "@/app/api/routes/connect/oauthExternal/identityConnectionTestResult";
import { inTx, type Tx } from "@/storage/inTx";
import type { AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";
import {
    authorizeTeamIdentityAdministrationInTx,
} from "@/app/teams/identity/teamIdentityAdministrationAuthority";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import {
    publishIdentityProviderTeamsChangedInTx,
    publishTeamChangedInTx,
} from "@/app/teams/teamChanges";

import type { HomeAdministrationActionV1 } from '@happier-dev/protocol/home/governance';

import { recordHomeAdministrationEventInTx } from "@/app/home/audit/homeAdministrationEvents";
import { readHomeGovernanceAccountInTx, resolveHomeGovernanceAuthority } from "./homeCapabilities";
import { readHomeIdentityMethodWithdrawalBlockerInTx } from "@/app/teams/identity/homeIdentityMethodWithdrawal";
import { publishHomeGovernanceChangedInTx } from "./governanceChanges";
import { readHomeGovernancePolicyInTx, resolveTeamProviderKindPolicy } from "./governancePolicy";

async function canManageHomeAuthenticationInTx(tx: Tx, actorAccountId: string): Promise<boolean> {
    const actor = await readHomeGovernanceAccountInTx(tx, actorAccountId);
    return resolveHomeGovernanceAuthority(actor).manageAuthentication;
}

function providerOwner(input: Readonly<{ owner?: ProviderCatalogContext }>): ProviderCatalogContext {
    return input.owner ?? HOME_PROVIDER_CONTEXT;
}

async function acquireHomeProviderMutationAdmissionInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; owner?: ProviderCatalogContext; id?: string }>,
    intent: AccountAdmissionIntent = "exclusive",
): Promise<void> {
    await acquireIdentityProviderMutationAdmissionInTx(tx, {
        owner: providerOwner(input), ...(input.id ? { id: input.id } : {}),
        additionalAccountIds: [input.actorAccountId],
        intent,
    });
}

type HomeProviderAuditAction = Extract<HomeAdministrationActionV1, `identity_provider.${string}`>;

/**
 * Provider instances owned by the Home are part of its administrative auth
 * projection. Publish only after their lifecycle owner reports a committed
 * mutation; Team-owned instances use the Team identity owner's invalidation.
 * A committed Home-owned mutation is also Home administration, so it is recorded
 * in Activity here, in the same transaction, naming the provider and never a secret.
 */
export async function publishCommittedHomeProviderMutationInTx(
    tx: Tx,
    owner: ProviderCatalogContext,
    providerInstanceId: string,
    committed: boolean,
    /** `null` for a fact about the provider rather than an administrator's change (a recorded test). */
    audit: Readonly<{ actorAccountId: string; action: HomeProviderAuditAction; displayName?: string }> | null,
): Promise<void> {
    if (!committed) return;
    if (owner.kind === "home") {
        const displayName = !audit ? null : audit.displayName ?? (await tx.identityProviderInstance.findUnique({
            where: { id: providerInstanceId },
            select: { displayName: true },
        }))?.displayName;
        if (audit && displayName) {
            await recordHomeAdministrationEventInTx(tx, {
                actor: { kind: "account", accountId: audit.actorAccountId },
                target: { kind: "identity_provider", id: providerInstanceId },
                detail: { action: audit.action, summary: { displayName } },
            });
        }
        await publishHomeGovernanceChangedInTx(tx);
        await publishIdentityProviderTeamsChangedInTx(tx, { providerInstanceId });
    } else {
        await publishTeamChangedInTx(tx, { teamId: owner.teamId });
    }
}

async function resolveProviderOwnerAuthorizationInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        owner?: ProviderCatalogContext;
    }>,
    operation: "view" | "mutate" = "mutate",
): Promise<Readonly<{
    status: "authorized" | "forbidden" | "team_authentication_required" | "team_authentication_unavailable";
}>> {
    const owner = providerOwner(input);
    if (owner.kind === "home") {
        return { status: await canManageHomeAuthenticationInTx(tx, input.actorAccountId) ? "authorized" : "forbidden" };
    }
    const authority = await authorizeTeamIdentityAdministrationInTx(tx, {
        actorAccountId: input.actorAccountId,
        teamId: owner.teamId,
        env: input.env,
        authenticationEvidence: input.authenticationEvidence,
        authenticationAuthority: input.authenticationAuthority,
        legacyHomeCredential: input.legacyHomeCredential,
    }, operation);
    if (!authority.ok) {
        return {
            status: authority.error === "team_authentication_required" || authority.error === "team_authentication_unavailable"
                ? authority.error
                : "forbidden",
        };
    }
    return {
        status: resolveTeamProviderKindPolicy(await readHomeGovernancePolicyInTx(tx), "oidc") === "allowed"
            ? "authorized"
            : "forbidden",
    };
}

async function authorizeProviderOwnerInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        owner?: ProviderCatalogContext;
    }>,
    operation: "view" | "mutate" = "mutate",
) {
    const authorization = await resolveProviderOwnerAuthorizationInTx(tx, input, operation);
    return authorization.status === "authorized" ? null : { status: authorization.status } as const;
}

type HomeManagedIdentityProviderListInput = Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
}> & Partial<TeamOperationAuthenticationContext>;

export async function listHomeManagedIdentityProviders(input: HomeManagedIdentityProviderListInput) {
    return await inTx(tx => listHomeManagedIdentityProvidersInTx(tx, input));
}

/** Authorize and read inside an enclosing administration read snapshot. */
export async function listHomeManagedIdentityProvidersInTx(tx: Tx, input: HomeManagedIdentityProviderListInput) {
    const denied = await authorizeProviderOwnerInTx(tx, input, "view");
    if (denied) return denied;
    const owner = providerOwner(input);
    const instances = await listIdentityProviderInstancesInTx(tx, { owner });
    return {
        status: "ready" as const,
        instances: instances.filter((resolved) =>
            resolved.status !== "ready"
            || resolved.instance.kind === "oidc"
            || (owner.kind === "home" && resolved.instance.kind === "github_app_identity")),
    };
}

export async function createHomeManagedOidcProvider(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    displayName: string;
    config: Omit<OidcProviderConfig, "v" | "kind">;
    clientSecret: string;
}> & Partial<TeamOperationAuthenticationContext>) {
    return await inTx(async (tx) => {
        await acquireHomeProviderMutationAdmissionInTx(tx, input);
        const denied = await authorizeProviderOwnerInTx(tx, input);
        if (denied) return denied;
        const owner = providerOwner(input);
        const result = await createIdentityProviderInstanceInTx(tx, {
            owner,
            kind: "oidc",
            displayName: input.displayName,
            config: { v: 1, kind: "oidc", ...input.config },
            secrets: { v: 1, kind: "oidc", clientSecret: input.clientSecret },
            createdByAccountId: input.actorAccountId,
        });
        if (result.status === "created") {
            await publishCommittedHomeProviderMutationInTx(tx, owner, result.instance.id, true, {
                actorAccountId: input.actorAccountId,
                action: "identity_provider.create",
            });
        }
        return result;
    }, { isolationLevel: "Serializable" /* Provider creation participates in Home-policy and final-login viability admission. */ });
}

export async function updateHomeManagedIdentityProvider(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    id: string;
    expectedRevision: number;
    displayName?: string;
    config?: unknown;
}> & Partial<TeamOperationAuthenticationContext>) {
    return await inTx(async (tx) => {
        await acquireHomeProviderMutationAdmissionInTx(tx, input, input.config === undefined ? "content" : "exclusive");
        const denied = await authorizeProviderOwnerInTx(tx, input);
        if (denied) return denied;
        const owner = providerOwner(input);
        const current = await readIdentityProviderInstanceInTx(tx, { id: input.id, owner });
        if (current.status !== "ready") return current;
        if (current.instance.kind !== "oidc") return { status: "provider_unavailable" as const };
        const result = await updateIdentityProviderInstanceInTx(tx, {
            id: input.id,
            owner,
            expectedRevision: input.expectedRevision,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.config === undefined ? {} : { config: input.config }),
        });
        await publishCommittedHomeProviderMutationInTx(tx, owner, input.id, result.status === "applied", {
            actorAccountId: input.actorAccountId,
            action: "identity_provider.update",
        });
        return result;
    }, { isolationLevel: "Serializable" /* Provider configuration participates in Home-policy and final-login viability admission. */ });
}

export async function replaceHomeManagedIdentityProviderSecret(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    id: string;
    expectedRevision: number;
    clientSecret: string;
}> & Partial<TeamOperationAuthenticationContext>) {
    return await inTx(async (tx) => {
        await acquireHomeProviderMutationAdmissionInTx(tx, input);
        const denied = await authorizeProviderOwnerInTx(tx, input);
        if (denied) return denied;
        const owner = providerOwner(input);
        const current = await readIdentityProviderInstanceInTx(tx, { id: input.id, owner });
        if (current.status !== "ready") return current;
        if (current.instance.kind !== "oidc") return { status: "provider_unavailable" as const };
        const result = await replaceIdentityProviderSecretsInTx(tx, {
            id: input.id,
            owner,
            expectedRevision: input.expectedRevision,
            secrets: { v: 1, kind: "oidc", clientSecret: input.clientSecret },
        });
        await publishCommittedHomeProviderMutationInTx(tx, owner, input.id, result.status === "applied", {
            actorAccountId: input.actorAccountId,
            action: "identity_provider.secret.replace",
        });
        return result;
    }, { isolationLevel: "Serializable" /* Provider secret revision participates in current runtime and final-login viability admission. */ });
}

export async function setHomeManagedIdentityProviderEnabled(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    id: string;
    expectedRevision: number;
    expectedSecurityRevision: number;
    enabled: boolean;
}> & Partial<TeamOperationAuthenticationContext>) {
    if (input.enabled) {
        const validation = await validateHomeManagedIdentityProviderRuntime({
            actorAccountId: input.actorAccountId,
            owner: providerOwner(input),
            id: input.id,
            expectedRevision: input.expectedRevision,
            expectedSecurityRevision: input.expectedSecurityRevision,
            env: input.env,
            authenticationEvidence: input.authenticationEvidence,
            authenticationAuthority: input.authenticationAuthority,
        }, { allowHomeManagedGitHub: true });
        if (validation.status !== "validated") return validation;

        return await inTx(async (tx) => {
            await acquireHomeProviderMutationAdmissionInTx(tx, input);
            const denied = await authorizeProviderOwnerInTx(tx, input);
            if (denied) return denied;
            const currentRuntime = await resolveRuntimeInTx(tx, {
                env: input.env ?? process.env,
                reference: validation.reference,
                purpose: "identity_connection_test",
            });
            if (!currentRuntime.ok) {
                const current = await readIdentityProviderInstanceInTx(tx, {
                    id: input.id,
                    owner: providerOwner(input),
                });
                return {
                    status: "revision_conflict" as const,
                    instance: current.status === "ready" ? current.instance : null,
                };
            }
            const owner = providerOwner(input);
            const result = await setIdentityProviderInstanceEnabledInTx(tx, {
                id: input.id,
                owner,
                expectedRevision: input.expectedRevision,
                expectedSecurityRevision: input.expectedSecurityRevision,
                enabled: true,
            });
            await publishCommittedHomeProviderMutationInTx(tx, owner, input.id, result.status === "applied", {
                actorAccountId: input.actorAccountId,
                action: "identity_provider.enable",
            });
            return result;
        }, { isolationLevel: "Serializable" /* Provider availability changes participate in the final-login viability family. */ });
    }
    return await inTx(async (tx) => {
        await acquireHomeProviderMutationAdmissionInTx(tx, input);
        const denied = await authorizeProviderOwnerInTx(tx, input);
        if (denied) return denied;
        const owner = providerOwner(input);
        const current = await readIdentityProviderInstanceInTx(tx, { id: input.id, owner });
        if (current.status !== "ready") return current;
        if (current.instance.kind !== "oidc" && !(owner.kind === "home" && current.instance.kind === "github_app_identity")) {
            return { status: "provider_unavailable" as const };
        }
        if (owner.kind === "home" && current.instance.enabled && await readHomeIdentityMethodWithdrawalBlockerInTx(tx, {
            env: input.env ?? process.env,
            providerInstanceId: input.id,
        }) !== null) return { status: "in_use" as const };
        const result = await setIdentityProviderInstanceEnabledInTx(tx, {
            id: input.id,
            owner,
            expectedRevision: input.expectedRevision,
            expectedSecurityRevision: input.expectedSecurityRevision,
            enabled: false,
        });
        await publishCommittedHomeProviderMutationInTx(tx, owner, input.id, result.status === "applied", {
            actorAccountId: input.actorAccountId,
            action: "identity_provider.disable",
        });
        return result;
    }, { isolationLevel: "Serializable" /* Provider availability changes participate in the final-login viability family. */ });
}

type HomeManagedIdentityProviderRuntimeValidationResult =
    | Readonly<{
        status: "validated";
        instance: Extract<Awaited<ReturnType<typeof readIdentityProviderInstanceInTx>>, { status: "ready" }>["instance"];
        reference: ProviderReference;
    }>
    | Readonly<{
        status: "forbidden" | "not_found" | "unreadable" | "provider_unavailable"
            | "team_authentication_required" | "team_authentication_unavailable";
    }>
    | Readonly<{
        status: "revision_conflict";
        instance: Extract<Awaited<ReturnType<typeof readIdentityProviderInstanceInTx>>, { status: "ready" }>["instance"];
    }>
    | Readonly<{ status: "validation_failed"; error: unknown }>;

/**
 * Resolves one exact disabled-or-enabled owner-scoped draft through the catalog and asks
 * its provider leaf to perform real, non-mutating validation. Secret custody,
 * network policy, discovery, and capability checks remain in their canonical
 * owners; this administration service only composes them with owner authority.
 */
async function validateHomeManagedIdentityProviderRuntime(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    id: string;
    expectedRevision?: number;
    expectedSecurityRevision?: number;
}> & Partial<TeamOperationAuthenticationContext>, options: Readonly<{
    allowHomeManagedGitHub?: boolean;
}> = {}): Promise<HomeManagedIdentityProviderRuntimeValidationResult> {
    const env = input.env ?? process.env;
    const selected = await inTx(async (tx) => {
        const denied = await authorizeProviderOwnerInTx(tx, input);
        if (denied) return denied;
        const current = await readIdentityProviderInstanceInTx(tx, {
            id: input.id,
            owner: providerOwner(input),
        });
        if (current.status !== "ready") return current;
        const owner = providerOwner(input);
        if (
            current.instance.kind !== "oidc"
            && !(
                options.allowHomeManagedGitHub === true
                && owner.kind === "home"
                && current.instance.kind === "github_app_identity"
            )
        ) {
            return { status: "provider_unavailable" as const };
        }
        if (
            (input.expectedRevision !== undefined && current.instance.revision !== input.expectedRevision)
            || (
                input.expectedSecurityRevision !== undefined
                && current.instance.securityRevision !== input.expectedSecurityRevision
            )
        ) return { status: "revision_conflict" as const, instance: current.instance };
        const runtime = await resolveOAuthRuntimeByIdInTx(
            tx,
            env,
            input.id,
            owner,
            "identity_connection_test",
        );
        const validateConfiguration = runtime?.provider.validateConfiguration;
        if (!runtime || (current.instance.kind === "oidc" && !validateConfiguration)) {
            return { status: "provider_unavailable" as const };
        }
        return { status: "selected" as const, instance: current.instance, runtime, validateConfiguration };
    });
    if (selected.status !== "selected") return selected;
    try {
        await selected.validateConfiguration?.({ env });
        return {
            status: "validated",
            instance: selected.instance,
            reference: selected.runtime.reference,
        };
    } catch (error) {
        return { status: "validation_failed", error };
    }
}

export async function validateHomeManagedIdentityProvider(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    id: string;
    expectedRevision: number;
    expectedSecurityRevision: number;
}> & Partial<TeamOperationAuthenticationContext>) {
    const result = await validateHomeManagedIdentityProviderRuntime(input);
    return result.status === "validated"
        ? { status: "validated" as const, instance: result.instance }
        : result;
}

export async function startHomeManagedIdentityProviderTest(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    id: string;
    expectedRevision: number;
    expectedSecurityRevision: number;
}> & TeamOperationAuthenticationContext) {
    const selected = await inTx(async (tx) => {
        const denied = await authorizeProviderOwnerInTx(tx, input);
        if (denied) return denied;
        const current = await readIdentityProviderInstanceInTx(tx, {
            id: input.id,
            owner: providerOwner(input),
        });
        if (current.status !== "ready") return current;
        if (
            current.instance.revision !== input.expectedRevision
            || current.instance.securityRevision !== input.expectedSecurityRevision
        ) return { status: "revision_conflict" as const, instance: current.instance };
        const runtime = await resolveOAuthRuntimeByIdInTx(
            tx,
            process.env,
            input.id,
            providerOwner(input),
            "identity_connection_test",
        );
        return runtime && current.instance.kind === "oidc"
            ? { status: "selected" as const, runtime }
            : { status: "provider_unavailable" as const };
    });
    if (selected.status !== "selected") return selected;
    try {
        if (!selected.runtime.provider.validateConfiguration) {
            return { status: "provider_unavailable" as const };
        }
        await selected.runtime.provider.validateConfiguration?.({ env: process.env });
        const attempt = await createExternalAuthorizeAttempt({
            flow: "connect",
            providerId: input.id,
            provider: selected.runtime.provider,
            reference: selected.runtime.reference,
            env: process.env,
            userId: input.actorAccountId,
            purpose: "identity_connection_test",
        });
        return attempt
            ? { status: "started" as const, attempt }
            : { status: "test_unavailable" as const };
    } catch (error) {
        return { status: "validation_failed" as const, error };
    }
}

export async function consumeHomeManagedIdentityProviderTest(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    id: string;
    resultHandle: string;
}> & TeamOperationAuthenticationContext) {
    return await inTx(async (tx) => {
        await acquireHomeProviderMutationAdmissionInTx(tx, input);
        const denied = await authorizeProviderOwnerInTx(tx, input);
        if (denied) return denied;
        const result = await consumeIdentityConnectionTestResultInTx(tx, {
            resultHandle: input.resultHandle,
            initiatorAccountId: input.actorAccountId,
        });
        if (
            !result
            || result.securityBinding.provider.id !== input.id
            || !isSameProviderContext(result.securityBinding.provider.context, providerOwner(input))
            || result.securityBinding.connection !== null
        ) return { status: "test_invalid" as const };
        const runtime = await resolveRuntimeInTx(tx, {
            env: process.env,
            reference: result.securityBinding.provider,
            purpose: "identity_connection_test",
        });
        if (!runtime.ok) return { status: "test_invalid" as const };
        const current = await readIdentityProviderInstanceInTx(tx, {
            id: input.id,
            owner: providerOwner(input),
        });
        if (current.status !== "ready") return current;
        const recorded = await recordIdentityProviderInstanceSuccessfulTestInTx(tx, {
            id: input.id,
            owner: providerOwner(input),
            securityRevision: current.instance.securityRevision,
            runtimeFingerprint: result.securityBinding.provider.runtimeFingerprint,
            testedAt: result.testedAt,
        });
        if (recorded.status !== "applied") return { status: "test_invalid" as const };
        await publishCommittedHomeProviderMutationInTx(
            tx,
            providerOwner(input),
            input.id,
            true,
            null,
        );
        return {
            status: "consumed" as const,
            instance: recorded.instance,
            diagnostics: result.diagnostics,
            testedAt: result.testedAt,
        };
    }, { isolationLevel: "Serializable" /* Successful provider test evidence participates in runtime availability and login-viability admission. */ });
}

export async function preflightDeleteHomeManagedIdentityProvider(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    id: string;
    expectedRevision: number;
}> & Partial<TeamOperationAuthenticationContext>) {
    return await inTx(async (tx) => {
        const denied = await authorizeProviderOwnerInTx(tx, input);
        if (denied) return denied;
        return await preflightDeleteIdentityProviderInstanceInTx(tx, {
            id: input.id,
            owner: providerOwner(input),
            expectedRevision: input.expectedRevision,
        });
    });
}

export async function deleteHomeManagedIdentityProvider(input: Readonly<{
    actorAccountId: string;
    owner?: ProviderCatalogContext;
    id: string;
    expectedRevision: number;
}> & Partial<TeamOperationAuthenticationContext>) {
    return await inTx(async (tx) => {
        await acquireHomeProviderMutationAdmissionInTx(tx, input);
        const denied = await authorizeProviderOwnerInTx(tx, input);
        if (denied) return denied;
        const owner = providerOwner(input);
        // Named before it is gone, so Activity can still say which provider was removed.
        const removing = await tx.identityProviderInstance.findUnique({
            where: { id: input.id },
            select: { displayName: true },
        });
        // Linked identities already block removal, so only a Team policy that
        // accepts this Home method can still depend on it.
        if (owner.kind === "home" && removing && await readHomeIdentityMethodWithdrawalBlockerInTx(tx, {
            env: input.env ?? process.env,
            providerInstanceId: input.id,
        }) === "team_authentication_policy_in_use") return { status: "in_use" as const };
        const result = await deleteIdentityProviderInstanceInTx(tx, {
            id: input.id,
            owner,
            expectedRevision: input.expectedRevision,
        });
        await publishCommittedHomeProviderMutationInTx(tx, owner, input.id, result.status === "deleted", {
            actorAccountId: input.actorAccountId,
            action: "identity_provider.remove",
            ...(removing ? { displayName: removing.displayName } : {}),
        });
        return result;
    }, { isolationLevel: "Serializable" /* Provider deletion checks surviving login routes across identities, passwords and Home owners. */ });
}
