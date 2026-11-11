import { NO_HOME_CAPABILITIES_V1, isActiveHomeAccountStatus, type AccountStatusV1, type HomeAccountMutationCapabilitiesV1, type HomeAccountMutationCapabilityV1, type HomeAccountMutationUnavailableReasonV1, type HomeCapabilitiesV1, type HomeRoleV1, type TeamCreationPolicyV1 } from '@happier-dev/protocol/home/governance';

import type { Tx } from "@/storage/inTx";

/**
 * The current Home-authority facts of one Account, always read inside the
 * transaction that decides. Nothing else — no token claim, no cached
 * projection, no client assertion — may stand in for these two columns.
 */
export type HomeGovernanceAccountFacts = Readonly<{
    accountId: string;
    homeRole: HomeRoleV1;
    status: AccountStatusV1;
}>;

/**
 * The Home-governance half of the projected capabilities. Team creation is
 * excluded because it additionally depends on deployment availability and Home
 * policy, which no governance mutation needs to read.
 */
export type HomeGovernanceAuthority = Readonly<Omit<HomeCapabilitiesV1, "createTeam">>;

const MUTATION_AVAILABLE: HomeAccountMutationCapabilityV1 = Object.freeze({ status: "available" });

function mutationUnavailable(
    reason: HomeAccountMutationUnavailableReasonV1,
): HomeAccountMutationCapabilityV1 {
    return Object.freeze({ status: "unavailable", reason });
}

const DENIED_GOVERNANCE_AUTHORITY: HomeGovernanceAuthority = Object.freeze({
    viewAdministration: false,
    manageAccounts: false,
    manageHomeRoles: false,
    manageTeamCreationPolicy: false,
    manageAuthentication: false,
    manageHomeSettings: false,
    eraseAccounts: false,
    manageAllTeams: false,
});

/**
 * The fixed Home role → capability mapping.
 *
 * `manageAccounts` is the administrator's authority over ordinary
 * (`member`/`admin`) Accounts: their lifecycle and their role among the
 * non-owner roles. `manageHomeRoles` is the strictly stronger owner authority
 * that may add or remove Home owners and administer an owner Account at all.
 * Only an active Account holds any authority.
 */
export function resolveHomeGovernanceAuthority(
    account: HomeGovernanceAccountFacts | null,
): HomeGovernanceAuthority {
    if (!account || !isActiveHomeAccountStatus(account.status)) return DENIED_GOVERNANCE_AUTHORITY;
    if (account.homeRole === "member") return DENIED_GOVERNANCE_AUTHORITY;
    const isOwner = account.homeRole === "owner";
    return Object.freeze({
        viewAdministration: true,
        manageAccounts: true,
        manageHomeRoles: isOwner,
        manageTeamCreationPolicy: true,
        manageAuthentication: isOwner,
        manageHomeSettings: isOwner,
        eraseAccounts: isOwner,
        manageAllTeams: true,
    });
}

/**
 * The effective Team-creation decision: deployed capability, then Home policy,
 * then the viewer's own class. Administering Teams never implies creating one.
 */
export function resolveHomeTeamCreationCapability(input: Readonly<{
    account: HomeGovernanceAccountFacts | null;
    teamCreationPolicy: TeamCreationPolicyV1;
    teamsEnabled: boolean;
}>): boolean {
    if (!input.teamsEnabled) return false;
    const { account } = input;
    if (!account || !isActiveHomeAccountStatus(account.status)) return false;
    switch (input.teamCreationPolicy) {
        case "self_service":
            return true;
        case "managed_only":
            return account.homeRole === "owner" || account.homeRole === "admin";
        case "disabled":
            return false;
    }
}

/** The complete capability projection for one viewer of one explicit Home. */
export function resolveHomeCapabilitiesV1(input: Readonly<{
    account: HomeGovernanceAccountFacts | null;
    teamCreationPolicy: TeamCreationPolicyV1;
    teamsEnabled: boolean;
}>): HomeCapabilitiesV1 {
    const authority = resolveHomeGovernanceAuthority(input.account);
    if (authority === DENIED_GOVERNANCE_AUTHORITY) {
        return Object.freeze({
            ...NO_HOME_CAPABILITIES_V1,
            createTeam: resolveHomeTeamCreationCapability(input),
        });
    }
    return Object.freeze({
        ...authority,
        createTeam: resolveHomeTeamCreationCapability(input),
    });
}

export async function readHomeGovernanceAccountInTx(
    tx: Tx,
    accountId: string,
): Promise<HomeGovernanceAccountFacts | null> {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { id: true, homeRole: true, status: true },
    });
    if (!account) return null;
    return Object.freeze({ accountId: account.id, homeRole: account.homeRole, status: account.status });
}

export type HomeAccountErasureActorAuthorizationResult =
    | Readonly<{
        status: "authorized";
        actor: HomeGovernanceAccountFacts;
        authority: HomeGovernanceAuthority;
    }>
    | Readonly<{ status: "rejected"; code: "home_governance_forbidden" }>;

/**
 * Checks only the actor's current `eraseAccounts` capability. This deliberately
 * does not read a target, so an authorized caller can receive idempotent success
 * for an already-erased Account without exposing its absence to other roles.
 */
export async function authorizeHomeAccountErasureActorInTx(
    tx: Tx,
    actorAccountId: string,
): Promise<HomeAccountErasureActorAuthorizationResult> {
    const actor = await readHomeGovernanceAccountInTx(tx, actorAccountId);
    const authority = resolveHomeGovernanceAuthority(actor);
    if (!actor || !authority.eraseAccounts) {
        return { status: "rejected", code: "home_governance_forbidden" };
    }
    return { status: "authorized", actor, authority };
}

/**
 * The canonical last-owner predicate: `homeRole = owner AND status = active`.
 * Writes made earlier in the same transaction are visible here, so a
 * replacement owner assigned by the caller already counts.
 */
export async function countActiveHomeOwnersInTx(
    tx: Tx,
    options?: Readonly<{ excludeAccountId?: string }>,
): Promise<number> {
    return await tx.account.count({
        where: {
            homeRole: "owner",
            status: "active",
            ...(options?.excludeAccountId ? { id: { not: options.excludeAccountId } } : {}),
        },
    });
}

/**
 * One transition that might remove an active Home owner. `removesAccount` is
 * erasure; otherwise the unspecified half of the pair is unchanged.
 */
export type HomeOwnershipTransition = Readonly<{
    targetAccountId: string;
    nextHomeRole?: HomeRoleV1;
    nextStatus?: AccountStatusV1;
    removesAccount?: boolean;
}>;

export type HomeOwnershipGuardResult =
    | Readonly<{ status: "allowed" }>
    | Readonly<{ status: "target_not_found" }>
    | Readonly<{ status: "rejected"; code: "home_owner_transfer_required" }>;

/**
 * Refuses any role change, suspension, disablement, replacement, or erasure
 * that would leave an owned Home with zero active owners.
 *
 * Callers must run this inside the same serializable transaction that performs
 * the write: the transaction is decisive and a UI precheck is not. An unowned
 * Home is a bootstrap state, so a transition that cannot reduce the owner count
 * is allowed there rather than blocked.
 */
export async function assertHomeOwnershipSurvivesTransitionInTx(
    tx: Tx,
    transition: HomeOwnershipTransition,
): Promise<HomeOwnershipGuardResult> {
    const target = await readHomeGovernanceAccountInTx(tx, transition.targetAccountId);
    if (!target) return { status: "target_not_found" };
    const heldRequiredOwnership = target.homeRole === "owner" && isActiveHomeAccountStatus(target.status);
    if (!heldRequiredOwnership) return { status: "allowed" };
    if (!transition.removesAccount) {
        const nextHomeRole = transition.nextHomeRole ?? target.homeRole;
        const nextStatus = transition.nextStatus ?? target.status;
        if (nextHomeRole === "owner" && isActiveHomeAccountStatus(nextStatus)) return { status: "allowed" };
    }
    const remainingActiveOwners = await countActiveHomeOwnersInTx(tx, { excludeAccountId: target.accountId });
    if (remainingActiveOwners > 0) return { status: "allowed" };
    return { status: "rejected", code: "home_owner_transfer_required" };
}

/**
 * The governance operations an authenticated principal can request. Internal
 * compositions (provider replacement, erasure continuation) carry their own
 * trusted authority and are not expressed here.
 */
export type HomeGovernanceMutationRequest =
    | Readonly<{ operation: "view" }>
    | Readonly<{ operation: "set_team_creation_policy" }>
    | Readonly<{ operation: "set_authentication_policy" }>
    | Readonly<{ operation: "manage_home_settings" }>
    | Readonly<{ operation: "set_home_role"; targetAccountId: string; nextHomeRole: HomeRoleV1 }>
    | Readonly<{ operation: "set_account_status"; targetAccountId: string; nextStatus: AccountStatusV1 }>
    | Readonly<{ operation: "erase_account"; targetAccountId: string }>
    | Readonly<{ operation: "manage_public_profile"; targetAccountId: string }>
    | Readonly<{ operation: "sign_out_account_everywhere"; targetAccountId: string }>;

export type HomeGovernanceAuthorizationResult =
    | Readonly<{
        status: "authorized";
        actor: HomeGovernanceAccountFacts;
        authority: HomeGovernanceAuthority;
        target: HomeGovernanceAccountFacts | null;
    }>
    | Readonly<{ status: "rejected"; code: "home_governance_forbidden" | "home_account_not_found" }>;

function requestTargetAccountId(request: HomeGovernanceMutationRequest): string | null {
    switch (request.operation) {
        case "set_home_role":
        case "set_account_status":
        case "erase_account":
        case "manage_public_profile":
        case "sign_out_account_everywhere":
            return request.targetAccountId;
        default:
            return null;
    }
}

function isAuthorizedRequest(input: Readonly<{
    authority: HomeGovernanceAuthority;
    request: HomeGovernanceMutationRequest;
    target: HomeGovernanceAccountFacts | null;
}>): boolean {
    const { authority, request, target } = input;
    switch (request.operation) {
        case "view":
            return authority.viewAdministration;
        case "set_team_creation_policy":
            return authority.manageTeamCreationPolicy;
        case "set_authentication_policy":
            return authority.manageAuthentication;
        case "manage_home_settings":
            return authority.manageHomeSettings;
        case "set_home_role": {
            const touchesOwnership = target?.homeRole === "owner" || request.nextHomeRole === "owner";
            return touchesOwnership ? authority.manageHomeRoles : authority.manageAccounts;
        }
        case "set_account_status":
        case "sign_out_account_everywhere":
        case "manage_public_profile":
            // Administering an owner Account at all is owner authority, whether
            // or not another active owner would remain.
            return target?.homeRole === "owner" ? authority.manageHomeRoles : authority.manageAccounts;
        case "erase_account":
            return authority.eraseAccounts;
    }
}

/** Presentation of the same operator authority enforced by each profile mutation. */
export function resolveHomePublicProfileManagementCapabilityV1(input: Readonly<{
    actor: HomeGovernanceAccountFacts;
    target: HomeGovernanceAccountFacts;
}>): HomeAccountMutationCapabilityV1 {
    return isAuthorizedRequest({
        authority: resolveHomeGovernanceAuthority(input.actor),
        request: { operation: "manage_public_profile", targetAccountId: input.target.accountId },
        target: input.target,
    }) ? MUTATION_AVAILABLE : mutationUnavailable("not_authorized");
}

/**
 * Projects the exact mutations one viewer may currently request for one row.
 *
 * This is the presentation face of the same Home authorization owner used by
 * mutations below. Ownership continuity and the Team erasure predicate are
 * supplied from the same transaction that reads the roster; clients never
 * reconstruct either decision from role strings or aggregate owner counts.
 */
export function resolveHomeAccountMutationCapabilitiesV1(input: Readonly<{
    actor: HomeGovernanceAccountFacts;
    target: HomeGovernanceAccountFacts;
    activeOwnerCount: number;
    teamOwnershipAllowsErasure: boolean;
}>): HomeAccountMutationCapabilitiesV1 {
    const authority = resolveHomeGovernanceAuthority(input.actor);
    const targetIsActiveOwner = input.target.homeRole === "owner"
        && isActiveHomeAccountStatus(input.target.status);
    const lastActiveOwner = targetIsActiveOwner && input.activeOwnerCount <= 1;

    const roleCapability = (nextHomeRole: HomeRoleV1): HomeAccountMutationCapabilityV1 => {
        const request = {
            operation: "set_home_role" as const,
            targetAccountId: input.target.accountId,
            nextHomeRole,
        };
        if (!isAuthorizedRequest({ authority, request, target: input.target })) {
            return mutationUnavailable("not_authorized");
        }
        if (nextHomeRole === input.target.homeRole) return mutationUnavailable("unchanged");
        if (lastActiveOwner && nextHomeRole !== "owner") return mutationUnavailable("last_active_owner");
        if (nextHomeRole !== "member" && !isActiveHomeAccountStatus(input.target.status)) {
            return mutationUnavailable("target_inactive");
        }
        return MUTATION_AVAILABLE;
    };

    const statusAuthorized = (nextStatus: AccountStatusV1): boolean => isAuthorizedRequest({
        authority,
        request: {
            operation: "set_account_status",
            targetAccountId: input.target.accountId,
            nextStatus,
        },
        target: input.target,
    });

    const disable = !statusAuthorized("suspended")
        ? mutationUnavailable("not_authorized")
        : input.target.status !== "active"
            ? mutationUnavailable("target_not_active")
            : lastActiveOwner
                ? mutationUnavailable("last_active_owner")
                : MUTATION_AVAILABLE;

    const reenable = !statusAuthorized("active")
        ? mutationUnavailable("not_authorized")
        : input.target.status === "disabled"
            ? mutationUnavailable("target_retired")
            : input.target.status !== "suspended"
                ? mutationUnavailable("target_not_suspended")
                : MUTATION_AVAILABLE;

    const eraseRequest = {
        operation: "erase_account" as const,
        targetAccountId: input.target.accountId,
    };
    const deleteCapability = !isAuthorizedRequest({ authority, request: eraseRequest, target: input.target })
        ? mutationUnavailable("not_authorized")
        : lastActiveOwner
            ? mutationUnavailable("last_active_owner")
            : !input.teamOwnershipAllowsErasure
                ? mutationUnavailable("team_owner_transfer_required")
                : MUTATION_AVAILABLE;

    // Ending sessions changes no role or status, so ownership continuity does not apply; only an
    // active Account has sessions left to end.
    const signOutEverywhere = !isAuthorizedRequest({
        authority,
        request: { operation: "sign_out_account_everywhere", targetAccountId: input.target.accountId },
        target: input.target,
    })
        ? mutationUnavailable("not_authorized")
        : input.target.status !== "active"
            ? mutationUnavailable("target_not_active")
            : MUTATION_AVAILABLE;

    return Object.freeze({
        setRole: Object.freeze({
            member: roleCapability("member"),
            admin: roleCapability("admin"),
            owner: roleCapability("owner"),
        }),
        disable,
        reenable,
        delete: deleteCapability,
        signOutEverywhere,
    });
}

/**
 * The single authorization decision for every Home-governance route and Action.
 *
 * It rereads the actor and the target inside the caller's transaction, so a
 * role or lifecycle change that landed after the request was admitted is
 * honored. Last-owner safety is a separate invariant applied after this check;
 * neither substitutes for the other.
 */
export async function authorizeHomeGovernanceMutationInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; request: HomeGovernanceMutationRequest }>,
): Promise<HomeGovernanceAuthorizationResult> {
    const actor = await readHomeGovernanceAccountInTx(tx, input.actorAccountId);
    const authority = resolveHomeGovernanceAuthority(actor);
    if (!actor) return { status: "rejected", code: "home_governance_forbidden" };

    const targetAccountId = requestTargetAccountId(input.request);
    const target = targetAccountId === null
        ? null
        : targetAccountId === actor.accountId
            ? actor
            : await readHomeGovernanceAccountInTx(tx, targetAccountId);
    if (targetAccountId !== null && !target) {
        // Only an actor who may already enumerate Accounts learns that the
        // target is absent; everyone else receives the neutral denial.
        return authority.manageAccounts
            ? { status: "rejected", code: "home_account_not_found" }
            : { status: "rejected", code: "home_governance_forbidden" };
    }
    if (!isAuthorizedRequest({ authority, request: input.request, target })) {
        return { status: "rejected", code: "home_governance_forbidden" };
    }
    return { status: "authorized", actor, authority, target };
}
