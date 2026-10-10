import type {
    TeamAdmissibleRoleV1,
    TeamErrorCodeV1,
    TeamMemberManagementTargetV1,
    TeamMemberRemoveResultV1,
    TeamMembersListFilterV1,
    TeamMembersPageV1,
    TeamMembershipV1,
} from "@happier-dev/protocol/teams";
import {
    TEAM_MEMBERS_PAGE_LIMIT_DEFAULT_V1,
    decodeTeamMembersCursorV1,
    encodeTeamMembersCursorV1,
    teamMembersQueryKeyV1,
} from "@happier-dev/protocol/teams";

import { buildAccountTextPrefixFilter } from "@/app/account/accountTextPrefixFilter";
import { getDbProviderFromEnv } from "@/storage/prisma";
import type { Tx } from "@/storage/inTx";
import { withTeamSessionAccessEffectsInTx } from "./sessionAccessEffects";
import {
    TeamMembershipStatus,
    TeamRole,
    type SessionHistoryAccess,
} from "@/storage/enums.generated";
import { publishTeamChangedInTx } from "../teamChanges";
import {
    countActiveTeamOwnersInTx,
    qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextInTx,
    type TeamActorContext,
    type TeamOperationAuthenticationContext,
} from "../actorContext";
import {
    admitsNewTeamOwner,
    isHomeOwnerRecoveryPromotion,
    isStructurallyActiveOwner,
    resolveTeamLeaveDecision,
    type TeamMemberActorFacts,
} from "./capabilities";
import { resolveTeamMembershipCapabilitiesV1 } from "../capabilities";
import { readHomeGovernanceAccountInTx, resolveHomeGovernanceAuthority } from "@/app/home/governance/homeCapabilities";
import { admitTeamMemberInTx, setTeamMembershipStatusInTx } from "./membershipService";
import { withdrawIneligibleDirectoryGroupContributionsInTx } from "./externalFacts";
import {
    isExternallyManagedMembership,
    projectTeamMembershipV1,
    TEAM_MEMBERSHIP_ROW_SELECT,
    type TeamMembershipRow,
} from "./project";
import { revokeTeamCredentialExternalApiKeysForMembershipInTx } from "../credentials/externalApiKey";
import { revokeTeamCredentialAudienceForMembershipInTx } from "../credentials/resourceAudience";
import { recordHomeAdministrationEventInTx } from "@/app/home/audit/homeAdministrationEvents";

/**
 * The authorized Team-member administration operations.
 *
 * Every entry point re-resolves the actor's current authority and the target's
 * current facts inside the caller's transaction, so a stale roster, a demotion
 * between render and submit, or an owner removed mid-flight cannot admit a
 * mutation. Routes map these typed results to HTTP and hold no rule of their own.
 *
 * The membership *primitive* — minting a lifetime and its horizon — lives in
 * `membershipService.ts` and is shared with Team creation, invitation
 * acceptance, and the external-fact adapters. This module is the actor-facing
 * half: it decides who may act, then calls that one primitive. Splitting them
 * this way is what lets an unattended directory reconciler reach the same
 * canonical write without inheriting a human capability check it cannot satisfy.
 */

export type TeamMemberServiceError = Extract<TeamErrorCodeV1,
    | "teams_unavailable"
    | "team_not_found"
    | "team_forbidden"
    | "team_archived"
    | "team_authentication_required"
    | "team_authentication_unavailable"
    | "invalid_team_cursor"
    | "membership_not_found"
    | "managed_by_directory"
    | "management_conflict"
    | "team_owner_transfer_required"
    | "account_not_found"
    | "account_ineligible"
>;

export type TeamMemberServiceResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: TeamMemberServiceError }>;

function denied(error: TeamMemberServiceError): Readonly<{ ok: false; error: TeamMemberServiceError }> {
    return { ok: false, error };
}

function actorFacts(context: TeamActorContext): TeamMemberActorFacts {
    return {
        accountId: context.actorAccountId,
        manageMembers: context.teamCapabilities.manageMembers,
        manageOwners: context.teamCapabilities.manageOwners,
        homeManagesAllTeams: context.homeAuthority.manageAllTeams,
    };
}

/**
 * A Team the actor may not even see is indistinguishable from one that does not
 * exist, so a Team id cannot be probed. The gate is the context's read
 * admission: membership `viewTeam` — an archived Team stays visible to its
 * retained members, which is what makes the archived roster and restoration
 * reachable — plus the Home administrator recovering an ownerless Team, who
 * must reach the roster to appoint an owner.
 */
async function resolveTeamViewerContextInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
    }>,
): Promise<TeamMemberServiceResult<TeamActorContext>> {
    const context = await resolveTeamActorContextInTx(tx, input);
    if (!context || !context.readsTeamForRecovery) return denied("team_not_found");
    return { ok: true, value: context };
}

async function qualifyTeamViewerInTx(
    tx: Tx,
    input: Readonly<{
        context: TeamActorContext;
        authentication?: TeamOperationAuthenticationContext;
        allowHomeRecovery?: boolean;
    }>,
): Promise<TeamMemberServiceResult<TeamActorContext>> {
    if (input.allowHomeRecovery
        && input.context.ownerRequired
        && input.context.homeAuthority.manageAllTeams) {
        return { ok: true, value: input.context };
    }
    const qualified = await qualifyTeamOperationAuthenticationInTx(tx, {
        context: input.context,
        ...input.authentication,
    });
    return qualified.ok
        ? { ok: true, value: input.context }
        : denied(qualified.error);
}

/**
 * Roster read admission.
 *
 * A reader's Team membership is Team-derived authority, so a restricted Team
 * requires the Team credential for it. The Home administrator's owner-required
 * recovery is not Team-derived: it is independent of whether that administrator
 * also happens to be a member. So an unqualified member who holds it still
 * reaches the roster — through exactly the recovery projection (its Team
 * capabilities withheld), never the Team authority it did not qualify for. An
 * outsider holds no Team-derived authority to qualify at all.
 */
async function qualifyTeamRosterReaderInTx(
    tx: Tx,
    input: Readonly<{ context: TeamActorContext; authentication?: TeamOperationAuthenticationContext }>,
): Promise<TeamMemberServiceResult<TeamActorContext>> {
    const { context } = input;
    const recovers = context.ownerRequired && context.homeAuthority.manageAllTeams;
    if (context.teamCapabilities.viewTeam) {
        const qualified = await qualifyTeamOperationAuthenticationInTx(tx, { context, ...input.authentication });
        if (qualified.ok) return { ok: true, value: context };
        if (!recovers) return denied(qualified.error);
    } else if (!recovers) {
        return denied("team_not_found");
    }
    return {
        ok: true,
        value: {
            ...context,
            teamCapabilities: resolveTeamMembershipCapabilitiesV1({
                accountStatus: context.accountStatus,
                membership: null,
                teamArchivedAt: context.team.archivedAt,
            }),
        },
    };
}

async function readMembershipRowInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; membershipId: string }>,
): Promise<TeamMembershipRow | null> {
    const row = await tx.teamMembership.findUnique({
        where: { id: input.membershipId },
        select: TEAM_MEMBERSHIP_ROW_SELECT,
    });
    // A membership that belongs to another Team reads as absent: holding an id
    // must not reveal that it exists somewhere the caller cannot see.
    return row && row.teamId === input.teamId ? row : null;
}

/**
 * Whether the actor may administer this member's lifecycle at all.
 *
 * This is one question with one answer, asked before the per-operation state
 * checks: it is what separates "you may not" from "there is nothing to do",
 * which is why a repeated suspend can return `unchanged` without ever skipping
 * an authorization check.
 */
type MemberAdministrationAuthority = Readonly<{
    permitted: boolean;
    denial: TeamMemberServiceError;
}>;

function resolveMemberAdministrationAuthority(input: Readonly<{
    context: TeamActorContext;
    target: TeamMembershipRow;
    requiresNativeLifecycle: boolean;
}>): MemberAdministrationAuthority {
    if (input.context.team.archivedAt !== null) return { permitted: false, denial: "team_archived" };
    if (!input.context.teamCapabilities.manageMembers) {
        return { permitted: false, denial: "team_forbidden" };
    }
    if (input.target.role === TeamRole.owner && !input.context.teamCapabilities.manageOwners) {
        return { permitted: false, denial: "team_forbidden" };
    }
    if (input.requiresNativeLifecycle && isExternallyManagedMembership(input.target)) {
        return { permitted: false, denial: "managed_by_directory" };
    }
    return { permitted: true, denial: "team_forbidden" };
}

/**
 * Whether removing this exact lifetime from the active-owner set would leave the
 * Team with none. Counting the survivors rather than the target's own role is
 * what makes a two-owner Team's ordinary demotion succeed and the last one fail.
 */
async function wouldStrandTeamInTx(
    tx: Tx,
    input: Readonly<{ target: TeamMembershipRow }>,
): Promise<boolean> {
    if (!isStructurallyActiveOwner({
        role: input.target.role,
        status: input.target.status,
        accountStatus: input.target.account.status,
    })) return false;
    const survivors = await countActiveTeamOwnersInTx(tx, {
        teamId: input.target.teamId,
        excludeMembershipIds: [input.target.id],
    });
    return survivors === 0;
}

/**
 * Which of these Accounts a directory source of this Team could actually take
 * over: exactly the ones holding an unbound provisioned identity in one.
 *
 * This is the fact that makes the projected `setManagement` capability
 * executable rather than aspirational, and it is one query for a whole page
 * rather than a probe per row.
 */
async function readManagementTransferTargetsInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; accountIds: readonly string[] }>,
): Promise<ReadonlySet<string>> {
    if (input.accountIds.length === 0) return new Set();
    const identities = await tx.teamProvisionedIdentity.findMany({
        where: {
            teamMembershipId: null,
            boundAccountId: { in: [...input.accountIds] },
            source: {
                teamId: input.teamId,
                state: "active",
                activeReconcileRunId: null,
            },
        },
        distinct: ["boundAccountId"],
        select: { boundAccountId: true },
    });
    const targets = new Set<string>();
    for (const identity of identities) {
        if (identity.boundAccountId !== null) targets.add(identity.boundAccountId);
    }
    return targets;
}

async function projectMemberInTx(
    tx: Tx,
    input: Readonly<{ context: TeamActorContext; membershipId: string }>,
): Promise<TeamMembershipV1 | null> {
    const row = await readMembershipRowInTx(tx, {
        teamId: input.context.team.id,
        membershipId: input.membershipId,
    });
    if (!row) return null;
    return projectTeamMembershipV1({
        row,
        actor: actorFacts(input.context),
        teamArchivedAt: input.context.team.archivedAt,
        activeOwnerCount: await countActiveTeamOwnersInTx(tx, { teamId: input.context.team.id }),
        managementTransferTargets: await readManagementTransferTargetsInTx(tx, {
            teamId: input.context.team.id,
            accountIds: [row.accountId],
        }),
    });
}

/**
 * The roster lookup, matched against exactly what a roster row already shows:
 * the Account id it falls back to, and the name and username the display label
 * is derived from. It composes the one portable Account text filter the Home's
 * other person searches use, so a Home never matches a person two ways.
 */
function memberSearchPredicate(query: string) {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    return {
        OR: [
            { accountId: query },
            { account: { username: buildAccountTextPrefixFilter(query, provider) } },
            { account: { firstName: buildAccountTextPrefixFilter(query, provider) } },
            { account: { lastName: buildAccountTextPrefixFilter(query, provider) } },
        ],
    };
}

/** One Team membership of one Account, as Home administration may see it. */
export type HomeAdministeredTeamMembership = Readonly<{
    teamId: string;
    name: string;
    role: TeamRole;
    status: TeamMembershipStatus;
    archived: boolean;
}>;

/**
 * The Teams one Account belongs to, for the Home administrator's People detail.
 *
 * Authorized by the caller's Home `manageAccounts` authority, reread in this transaction: the
 * answer is a Home-governance fact about a person, not a Team read, so it needs no Team role and
 * is refused to everyone without account administration. It carries each Team's name and the
 * membership's role and status only — never Groups, Session access, provisioning or management
 * facts (`docs/teams.md`: Team administration authorizes governance only). Suspended memberships
 * and archived Teams are included and flagged.
 */
export async function listTeamMembershipsForAccountInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; accountId: string }>,
): Promise<TeamMemberServiceResult<readonly HomeAdministeredTeamMembership[]>> {
    const actor = await readHomeGovernanceAccountInTx(tx, input.actorAccountId);
    if (!resolveHomeGovernanceAuthority(actor).manageAccounts) return denied("team_forbidden");
    const rows = await tx.teamMembership.findMany({
        where: { accountId: input.accountId },
        select: { role: true, status: true, team: { select: { id: true, name: true, archivedAt: true } } },
        orderBy: [{ team: { name: "asc" } }, { teamId: "asc" }],
    });
    return {
        ok: true,
        value: rows.map((row) => Object.freeze({
            teamId: row.team.id,
            name: row.team.name,
            role: row.role,
            status: row.status,
            archived: row.team.archivedAt !== null,
        })),
    };
}

const MEMBER_FILTER_PREDICATES: Readonly<Record<TeamMembersListFilterV1, object>> = {
    all: {},
    owners_admins: { role: { in: [TeamRole.owner, TeamRole.admin] } },
    members: { role: TeamRole.member },
    guests: { role: TeamRole.guest },
    suspended: { status: TeamMembershipStatus.suspended },
};

/**
 * The Team roster, ordered by immutable creation time then lifetime id.
 *
 * Neither ordering component changes under a role edit, a suspension, a rename,
 * or a provider Account replacement, so a page sequence cannot shuffle beneath a
 * reader. An unusable cursor is reported rather than silently restarting at page
 * one, which would surface to the reader as duplicated rows.
 */
export async function listTeamMembersForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        filter: TeamMembersListFilterV1;
        /** Bounded roster lookup; an empty or blank value is no lookup at all. */
        query?: string;
        cursor?: string | null;
        limit?: number;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamMemberServiceResult<TeamMembersPageV1>> {
    const visible = await resolveTeamViewerContextInTx(tx, input);
    if (!visible.ok) return visible;
    const authorized = await qualifyTeamRosterReaderInTx(tx, {
        context: visible.value,
        authentication: input.authentication,
    });
    if (!authorized.ok) return authorized;
    const context = authorized.value;

    const query = input.query?.trim() ?? "";
    const queryKey = teamMembersQueryKeyV1({
        v: 1,
        teamId: input.teamId,
        filter: input.filter,
        ...(query === "" ? {} : { query }),
    });
    let after: Readonly<{ createdAt: number; id: string }> | null = null;
    if (input.cursor) {
        const decoded = decodeTeamMembersCursorV1(input.cursor, queryKey);
        if (decoded.status !== "ok") return denied("invalid_team_cursor");
        after = decoded.cursor;
    }

    const limit = input.limit ?? TEAM_MEMBERS_PAGE_LIMIT_DEFAULT_V1;
    const rows = await tx.teamMembership.findMany({
        where: {
            teamId: input.teamId,
            ...MEMBER_FILTER_PREDICATES[input.filter],
            // The lookup is a separate conjunct: the cursor clause below owns
            // `OR` for the keyset position.
            ...(query === "" ? {} : { AND: memberSearchPredicate(query) }),
            ...(after
                ? {
                    OR: [
                        { createdAt: { gt: new Date(after.createdAt) } },
                        { createdAt: new Date(after.createdAt), id: { gt: after.id } },
                    ],
                }
                : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1,
        select: TEAM_MEMBERSHIP_ROW_SELECT,
    });

    const page = rows.slice(0, limit);
    const activeOwnerCount = await countActiveTeamOwnersInTx(tx, { teamId: input.teamId });
    const managementTransferTargets = await readManagementTransferTargetsInTx(tx, {
        teamId: input.teamId,
        accountIds: page.map((row) => row.accountId),
    });
    const actor = actorFacts(context);
    const last = rows.length > limit ? page[page.length - 1] : undefined;

    return {
        ok: true,
        value: {
            items: page.map((row) => projectTeamMembershipV1({
                row,
                actor,
                teamArchivedAt: context.team.archivedAt,
                activeOwnerCount,
                managementTransferTargets,
            })),
            nextCursor: last
                ? encodeTeamMembersCursorV1({
                    queryKey,
                    createdAt: last.createdAt.getTime(),
                    id: last.id,
                })
                : null,
        },
    };
}

export async function getTeamMemberForActorInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string; membershipId: string; authentication?: TeamOperationAuthenticationContext }>,
): Promise<TeamMemberServiceResult<TeamMembershipV1>> {
    const visible = await resolveTeamViewerContextInTx(tx, input);
    if (!visible.ok) return visible;
    const authorized = await qualifyTeamRosterReaderInTx(tx, {
        context: visible.value,
        authentication: input.authentication,
    });
    if (!authorized.ok) return authorized;

    const member = await projectMemberInTx(tx, {
        context: authorized.value,
        membershipId: input.membershipId,
    });
    return member ? { ok: true, value: member } : denied("membership_not_found");
}

/**
 * Direct add of an already existing Account.
 *
 * Authorization, eligibility, and the horizon each stay with their own owner:
 * this function decides only whether the actor may admit anyone, then hands the
 * exact admission to the one minting primitive.
 */
export async function addTeamMemberForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        accountId: string;
        role: TeamAdmissibleRoleV1;
        historyAccess: SessionHistoryAccess;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamMemberServiceResult<TeamMembershipV1>> {
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const context = authorized.value;

    if (context.team.archivedAt !== null) return denied("team_archived");
    if (!context.teamCapabilities.manageMembers) return denied("team_forbidden");
    const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
    if (!qualified.ok) return qualified;

    const admitted = await admitTeamMemberInTx(tx, {
        teamId: input.teamId,
        accountId: input.accountId,
        role: input.role,
        historyAccess: input.historyAccess,
    });
    if (!admitted.ok) return denied(admitted.error);

    if (admitted.outcome === "added") {
        await publishTeamChangedInTx(tx, {
            teamId: input.teamId,
            additionalAccountIds: [input.accountId],
        });
    }
    const member = await projectMemberInTx(tx, {
        context,
        membershipId: admitted.membership.teamMembershipId,
    });
    return member ? { ok: true, value: member } : denied("membership_not_found");
}

/**
 * Change one member's role, preserving the lifetime and its history horizon.
 *
 * Two authorities can reach this operation and they are not the same:
 *
 * - ordinary Team administration, which needs `manageMembers`, additionally
 *   needs `manageOwners` whenever the current or resulting role is `owner`, and
 *   may never demote the final active owner;
 * - the narrow Home owner-required recovery, which applies only while the Team
 *   has no active owner, may only promote an existing active non-guest member to
 *   owner, and may never select the caller.
 *
 * Neither path touches `sessionAccessStartsAt`: a role change is not a new
 * admission, and rewriting the horizon would silently widen or narrow history.
 */
export async function setTeamMemberRoleForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        membershipId: string;
        role: TeamRole;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamMemberServiceResult<TeamMembershipV1>> {
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const context = authorized.value;

    const target = await readMembershipRowInTx(tx, input);
    if (!target) return denied("membership_not_found");
    if (context.team.archivedAt !== null) return denied("team_archived");

    const activeOwnerCount = await countActiveTeamOwnersInTx(tx, { teamId: input.teamId });
    // The two authorities compose. A Home owner who is also a Team admin holds
    // the same owner-required recovery as a Home owner who is a plain member of
    // the ownerless Team; ordinary administration's `manageOwners` rule cannot
    // cancel it, because the Home authority never came from the membership.
    const recovering = input.role === TeamRole.owner && isHomeOwnerRecoveryPromotion({
        actor: {
            accountId: context.actorAccountId,
            homeManagesAllTeams: context.homeAuthority.manageAllTeams,
        },
        target: {
            accountId: target.accountId,
            role: target.role,
            status: target.status,
            accountStatus: target.account.status,
        },
        activeOwnerCount,
    });

    let usesHomeRecovery = false;
    if (!context.teamCapabilities.manageMembers) {
        if (!recovering) return denied("team_forbidden");
        usesHomeRecovery = true;
    } else {
        const touchesOwner = target.role === TeamRole.owner || input.role === TeamRole.owner;
        if (touchesOwner && !context.teamCapabilities.manageOwners) {
            if (!recovering) return denied("team_forbidden");
            usesHomeRecovery = true;
        }
        if (input.role !== TeamRole.owner && await wouldStrandTeamInTx(tx, { target })) {
            return denied("team_owner_transfer_required");
        }
    }
    const qualified = await qualifyTeamViewerInTx(tx, {
        context,
        authentication: input.authentication,
        allowHomeRecovery: usesHomeRecovery,
    });
    if (!qualified.ok) return qualified;
    // A retry that leaves an existing owner an owner is not a new assignment.
    if (input.role === TeamRole.owner && target.role !== TeamRole.owner
        && !admitsNewTeamOwner({ accountStatus: target.account.status })) {
        return denied("account_ineligible");
    }

    if (target.role !== input.role) {
        await withTeamSessionAccessEffectsInTx(tx, {
            teamId: input.teamId, accountIds: [target.accountId], origin: "relationship_change",
            change: { kind: "teamRole", teamId: input.teamId },
        }, async () => {
            await tx.teamMembership.update({ where: { id: target.id }, data: { role: input.role } });
        });
        await publishTeamChangedInTx(tx, { teamId: input.teamId });
    }

    const projectionContext = await resolveTeamActorContextInTx(tx, input) ?? context;
    const member = await projectMemberInTx(tx, { context: projectionContext, membershipId: target.id });
    return member ? { ok: true, value: member } : denied("membership_not_found");
}

async function setTeamMemberStatusForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        membershipId: string;
        status: TeamMembershipStatus;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamMemberServiceResult<TeamMembershipV1>> {
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const context = authorized.value;

    const target = await readMembershipRowInTx(tx, input);
    if (!target) return denied("membership_not_found");

    const authority = resolveMemberAdministrationAuthority({
        context,
        target,
        requiresNativeLifecycle: true,
    });
    if (!authority.permitted) return denied(authority.denial);
    const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
    if (!qualified.ok) return qualified;

    if (target.status !== input.status) {
        // Ordinary administration may not revoke the final owner's access. This
        // is the routine path only: security offboarding revokes through the
        // Account lifecycle owner and deliberately leaves `ownerRequired` behind
        // rather than retaining unsafe access.
        if (input.status === TeamMembershipStatus.suspended
            && await wouldStrandTeamInTx(tx, { target })) {
            return denied("team_owner_transfer_required");
        }
        await setTeamMembershipStatusInTx(tx, {
            teamId: input.teamId,
            membershipId: target.id,
            accountId: target.accountId,
            status: input.status,
        });
        await publishTeamChangedInTx(tx, { teamId: input.teamId });
    }

    const projectionContext = await resolveTeamActorContextInTx(tx, input) ?? context;
    const member = await projectMemberInTx(tx, { context: projectionContext, membershipId: target.id });
    return member ? { ok: true, value: member } : denied("membership_not_found");
}

/**
 * Suspension changes exactly one column. It removes effective Team and Group
 * access immediately while preserving the lifetime id, role, Group rows, history
 * horizons, and member-targeted grants, so reactivation restores only the access
 * those retained facts still imply.
 */
export function suspendTeamMemberForActorInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string; membershipId: string; authentication?: TeamOperationAuthenticationContext }>,
): Promise<TeamMemberServiceResult<TeamMembershipV1>> {
    return setTeamMemberStatusForActorInTx(tx, { ...input, status: TeamMembershipStatus.suspended });
}

export function reactivateTeamMemberForActorInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string; membershipId: string; authentication?: TeamOperationAuthenticationContext }>,
): Promise<TeamMemberServiceResult<TeamMembershipV1>> {
    return setTeamMemberStatusForActorInTx(tx, { ...input, status: TeamMembershipStatus.active });
}

/**
 * Removal ends the membership lifetime.
 *
 * Group memberships, their external contributions, and membership-lifetime
 * grants cascade from the deleted row, which is why rejoining mints a genuinely
 * new lifetime and cannot resurrect old member-specific access. Session
 * authorship and other immutable history are untouched.
 *
 * An already-absent lifetime answers `unchanged` for an authorized manager, so a
 * retried confirmation reads as success rather than a failure; the authorization
 * check still runs first, so the answer discloses nothing.
 */
export async function removeTeamMemberForActorInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string; membershipId?: string; authentication?: TeamOperationAuthenticationContext }>,
): Promise<TeamMemberServiceResult<TeamMemberRemoveResultV1>> {
    const context = await resolveTeamActorContextInTx(tx, input);
    if (!context) return denied("team_not_found");
    const selfRemoval = input.membershipId === undefined || input.membershipId === context.membership?.id;
    if (!selfRemoval && !context.readsTeamForRecovery) return denied("team_not_found");

    const membershipId = input.membershipId ?? context.membership?.id;
    if (!membershipId) return denied("team_not_found");
    const target = await readMembershipRowInTx(tx, { teamId: input.teamId, membershipId });
    if (!target) {
        if (context.team.archivedAt !== null) return denied("team_archived");
        if (!context.teamCapabilities.manageMembers) return denied("team_forbidden");
        const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
        if (!qualified.ok) return qualified;
        return { ok: true, value: { status: "unchanged" } };
    }

    if (selfRemoval) {
        const decision = resolveTeamLeaveDecision({
            accountStatus: context.accountStatus,
            membership: { role: target.role, status: target.status, managedExternally: isExternallyManagedMembership(target) },
            activeOwnerCount: context.activeOwnerCount,
            teamArchivedAt: context.team.archivedAt,
        });
        if (!decision.permitted) return denied(decision.error);
    } else {
        const authority = resolveMemberAdministrationAuthority({ context, target, requiresNativeLifecycle: true });
        if (!authority.permitted) return denied(authority.denial);
    }
    const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
    if (!qualified.ok) return qualified;
    if (!selfRemoval && await wouldStrandTeamInTx(tx, { target })) return denied("team_owner_transfer_required");

    await withTeamSessionAccessEffectsInTx(tx, {
        teamId: input.teamId, accountIds: [target.accountId], origin: "relationship_change",
        change: { kind: "teamMembership", teamId: input.teamId },
    }, async () => {
        await revokeTeamCredentialExternalApiKeysForMembershipInTx(tx, {
            teamId: input.teamId,
            membershipId: target.id,
            actor: { kind: "account", accountId: input.actorAccountId },
        });
        await revokeTeamCredentialAudienceForMembershipInTx(tx, {
            teamId: input.teamId,
            teamMembershipId: target.id,
            accountId: target.accountId,
            actor: { kind: "account", accountId: input.actorAccountId },
        });
        await tx.teamMembership.delete({ where: { id: target.id } });
        await recordHomeAdministrationEventInTx(tx, {
            actor: { kind: "account", accountId: input.actorAccountId },
            target: { kind: "account", id: target.accountId },
            detail: { action: "teams.members.remove", summary: { teamId: input.teamId, membershipId: target.id, teamName: context.team.name } },
        });
    });
    await publishTeamChangedInTx(tx, {
        teamId: input.teamId,
        additionalAccountIds: [target.accountId],
    });
    return { ok: true, value: { status: "removed", membershipId: target.id } };
}

/**
 * The explicit management-source conversion.
 *
 * Binding is deliberate in both directions: a reconciler never seizes a native
 * membership, and a source never loses one silently. The lifetime, role, status,
 * and horizon are preserved throughout — only which owner may change them moves.
 *
 * The Lane 03 identity check is the real gate for binding: an exact provisioned
 * identity in that source must already resolve to this Account, and it must not
 * already own a different membership. Without one there is nothing to manage
 * through, which is a conflict rather than a permission problem.
 */
export async function setTeamMemberManagementForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        membershipId: string;
        management: TeamMemberManagementTargetV1;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamMemberServiceResult<TeamMembershipV1>> {
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const context = authorized.value;

    const target = await readMembershipRowInTx(tx, input);
    if (!target) return denied("membership_not_found");

    const authority = resolveMemberAdministrationAuthority({
        context,
        target,
        requiresNativeLifecycle: false,
    });
    if (!authority.permitted) return denied(authority.denial);
    const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
    if (!qualified.ok) return qualified;

    const [current, currentIdentityConnectionManagement] = await Promise.all([
        tx.teamProvisionedIdentity.findUnique({
            where: { teamMembershipId: target.id },
            select: { id: true, directorySourceId: true, state: true },
        }),
        tx.teamMembershipIdentityConnectionManagement.findUnique({
            where: { teamMembershipId: target.id },
            select: { teamMembershipId: true },
        }),
    ]);

    let nextIdentityId: string | null = null;
    let changesManagement = current !== null || currentIdentityConnectionManagement !== null;
    if (input.management.kind === "directory_source") {
        const { directorySourceId } = input.management;
        changesManagement = current?.directorySourceId !== directorySourceId;
        if (changesManagement) {
            const source = await tx.teamDirectorySource.findUnique({
                where: { id: directorySourceId },
                select: { id: true, teamId: true, state: true, activeReconcileRunId: true },
            });
            if (
                !source
                || source.teamId !== input.teamId
                || source.state !== "active"
                || source.activeReconcileRunId !== null
            ) return denied("management_conflict");

            const identity = await tx.teamProvisionedIdentity.findFirst({
                where: {
                    directorySourceId,
                    boundAccountId: target.accountId,
                    teamMembershipId: null,
                },
                select: { id: true },
            });
            if (!identity) return denied("management_conflict");
            nextIdentityId = identity.id;
        }
    }

    if (changesManagement) {
        await withTeamSessionAccessEffectsInTx(tx, {
            teamId: input.teamId,
            accountIds: [target.accountId],
            origin: "retained_lifecycle",
        }, async (sessionAccessImpacts) => {
            if (current) {
                await tx.teamProvisionedIdentity.update({
                    where: { id: current.id },
                    data: { teamMembershipId: null, teamMembershipTeamId: null },
                });
            }
            if (currentIdentityConnectionManagement) {
                await tx.teamMembershipIdentityConnectionManagement.delete({
                    where: { teamMembershipId: target.id },
                });
            }
            if (nextIdentityId) {
                await tx.teamProvisionedIdentity.update({
                    where: { id: nextIdentityId },
                    data: { teamMembershipId: target.id, teamMembershipTeamId: input.teamId },
                });
            }
            if (current) {
                await withdrawIneligibleDirectoryGroupContributionsInTx(tx, {
                    teamId: input.teamId,
                    teamMembershipId: target.id,
                    accountId: target.accountId,
                    directorySourceId: current.directorySourceId,
                    releasedIdentityState: current.state,
                    sessionAccessImpacts,
                });
            }
            await publishTeamChangedInTx(tx, { teamId: input.teamId });
        });
    }

    const member = await projectMemberInTx(tx, { context, membershipId: target.id });
    return member ? { ok: true, value: member } : denied("membership_not_found");
}
