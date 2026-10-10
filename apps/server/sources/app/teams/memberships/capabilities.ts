import { AccountStatus, TeamMembershipStatus, TeamRole } from "@/storage/enums.generated";
// Type-only, so this leaf domain rule stays off the protocol package's runtime graph
// while still being unable to drift from the published projection shape.
import type {
    TeamCapabilitiesV1,
    TeamMembershipCapabilitiesV1,
} from "@happier-dev/protocol/teams";

/**
 * The effective Team capabilities a person derives from one membership.
 *
 * This is the published projection shape itself, not a parallel server-local copy:
 * these are projected decisions, and routes, UI, and downstream lanes read the
 * booleans rather than comparing roles themselves.
 */
export type TeamMembershipCapabilities = TeamCapabilitiesV1;

type MembershipCapabilityInput = Readonly<{
    role: TeamRole;
    membershipStatus: TeamMembershipStatus;
    accountStatus: AccountStatus;
    teamArchivedAt: Date | null;
}>;

function resolveMembershipCapabilityBasis(input: MembershipCapabilityInput) {
    const current = input.accountStatus === AccountStatus.active
        && input.membershipStatus === TeamMembershipStatus.active;
    const archived = input.teamArchivedAt !== null;
    const manages = input.role === TeamRole.owner || input.role === TeamRole.admin;
    return { current, archived, manages, administersTeam: current && manages && !archived };
}

export type TeamCredentialCapabilities = Readonly<{
    offerOwnCredential: boolean;
    manageCredentials: boolean;
}>;

/** Internal resource authority; deliberately absent from the strict Team V1 wire projection. */
export function resolveTeamMembershipCredentialCapabilities(input: MembershipCapabilityInput): TeamCredentialCapabilities {
    const basis = resolveMembershipCapabilityBasis(input);
    return {
        offerOwnCredential: basis.current && !basis.archived
            && (basis.manages || input.role === TeamRole.member),
        manageCredentials: basis.administersTeam,
    };
}

const NONE: TeamMembershipCapabilities = {
    viewTeam: false,
    viewRoster: false,
    manageSettings: false,
    managePolicy: false,
    manageMembers: false,
    manageGroups: false,
    manageInvitations: false,
    manageAuthentication: false,
    manageOwners: false,
    archiveTeam: false,
    restoreTeam: false,
    leave: false,
};

/**
 * Map one membership to its fixed capabilities.
 *
 * Archival is deliberately not folded into a single "is this membership usable"
 * flag. An archived Team must stay visible to its retained members and restorable
 * by a retained owner or admin, while every other mutation stops — so archive
 * suppresses mutations but never discards the administrative visibility that makes
 * restoration reachable.
 *
 * An inactive Account or suspended membership yields nothing at all: those are
 * lifecycle facts owned elsewhere, and a stale role must never survive them.
 *
 * This mapping answers only what a membership confers. Home governance authority
 * (`manageAllTeams` and the narrow owner-required recovery) is a separate Home-owned
 * decision composed by the caller; folding it in here would create a second
 * authority for the same question. Feature availability, a configured Team
 * authentication requirement, and current transaction invariants still apply on top.
 */
export function resolveTeamMembershipCapabilities(
    input: MembershipCapabilityInput,
): TeamMembershipCapabilities {
    const { current, archived, manages, administersTeam } = resolveMembershipCapabilityBasis(input);
    if (!current) return NONE;

    return {
        viewTeam: true,
        viewRoster: true,
        manageSettings: administersTeam,
        managePolicy: administersTeam,
        manageMembers: administersTeam,
        manageGroups: administersTeam,
        manageInvitations: administersTeam,
        manageAuthentication: administersTeam,
        manageOwners: input.role === TeamRole.owner && !archived,
        archiveTeam: administersTeam,
        restoreTeam: manages && archived,
        leave: false,
    };
}

const NO_TARGET_CAPABILITIES: TeamMembershipCapabilitiesV1 = {
    setRole: false,
    assignableRoles: [],
    suspend: false,
    reactivate: false,
    remove: false,
    setManagement: false,
};

/** The actor half of a per-member decision, already composed by its own owners. */
export type TeamMemberActorFacts = Readonly<{
    accountId: string;
    /** Membership-derived Team capabilities; Home authority is carried separately. */
    manageMembers: boolean;
    manageOwners: boolean;
    /** Home `manageAllTeams`, which confers only §7.6 owner-required recovery. */
    homeManagesAllTeams: boolean;
}>;

/** The target half, always re-read inside the deciding transaction. */
export type TeamMemberTargetFacts = Readonly<{
    accountId: string;
    role: TeamRole;
    status: TeamMembershipStatus;
    accountStatus: AccountStatus;
    /** True when a directory source or identity connection owns this lifetime. */
    managedExternally: boolean;
    /**
     * True when this Team has a directory source holding an unbound provisioned
     * identity for this Account — the only thing a native-to-directory
     * conversion can bind to. Without it that conversion refuses by
     * construction, which is why it is a projected fact and not an assumption.
     */
    managementTransferTargetAvailable: boolean;
}>;

/**
 * The single owner-required recovery rule.
 *
 * Home `manageAllTeams` is not membership authority: its one membership power
 * is promoting an existing eligible non-guest member to owner — never the
 * caller, never a guest, never an inactive one — and only while the Team has no
 * active owner. The projection and the role mutation both decide it here, so
 * the two can never disagree about who may recover a Team, and it composes with
 * ordinary Team administration instead of replacing it: stronger Team
 * membership never cancels the Home authority a plain member would hold.
 */
export function isHomeOwnerRecoveryPromotion(input: Readonly<{
    actor: Pick<TeamMemberActorFacts, "accountId" | "homeManagesAllTeams">;
    target: Pick<TeamMemberTargetFacts, "accountId" | "role" | "status" | "accountStatus">;
    activeOwnerCount: number;
}>): boolean {
    return input.actor.homeManagesAllTeams
        && input.activeOwnerCount === 0
        && input.target.accountId !== input.actor.accountId
        && input.target.role !== TeamRole.guest
        && input.target.status === TeamMembershipStatus.active
        && admitsNewTeamOwner(input.target);
}

/**
 * Every new Team ownership requires an active Account — ordinary promotion and
 * Home recovery alike. Account retirement is the fence erasure relies on
 * against acquiring new required ownership (L01/01 Phase A, L01/02).
 */
export function admitsNewTeamOwner(target: Pick<TeamMemberTargetFacts, "accountStatus">): boolean {
    return target.accountStatus === AccountStatus.active;
}

/** A structurally active owner: active Account, active membership, owner role. */
export function isStructurallyActiveOwner(
    target: Readonly<{ role: TeamRole; status: TeamMembershipStatus; accountStatus: AccountStatus }>,
): boolean {
    return target.role === TeamRole.owner
        && target.status === TeamMembershipStatus.active
        && target.accountStatus === AccountStatus.active;
}

/** One self-removal decision for both the capability projection and its transaction. */
export function resolveTeamLeaveDecision(input: Readonly<{
    accountStatus: AccountStatus;
    membership: Readonly<{
        role: TeamRole;
        status: TeamMembershipStatus;
        managedExternally?: boolean;
    }> | null;
    activeOwnerCount?: number;
    teamArchivedAt: Date | null;
}>): Readonly<{ permitted: true }> | Readonly<{
    permitted: false;
    error: "team_forbidden" | "managed_by_directory" | "team_owner_transfer_required";
}> {
    if (input.accountStatus !== AccountStatus.active || !input.membership) {
        return { permitted: false, error: "team_forbidden" };
    }
    // Missing source/count evidence cannot advertise or admit self-removal.
    if (input.membership.managedExternally !== false) {
        return { permitted: false, error: "managed_by_directory" };
    }
    if (input.teamArchivedAt === null
        && isStructurallyActiveOwner({ ...input.membership, accountStatus: input.accountStatus })
        && (input.activeOwnerCount === undefined || input.activeOwnerCount <= 1)) {
        return { permitted: false, error: "team_owner_transfer_required" };
    }
    return { permitted: true };
}

/**
 * What one actor may do to one specific member.
 *
 * This exists because none of these answers is derivable from a role string, and
 * a client that tried would become a second authority for the same question. The
 * rules it encodes, each with its own reason:
 *
 * - an archived Team suppresses every membership mutation while retaining rows,
 *   so restoration remains the only way back;
 * - an admin may not touch an owner at all — every mutation whose current or
 *   resulting role is `owner` needs `manageOwners`, even when another owner
 *   remains, because "another owner exists right now" is not a stable fact;
 * - ordinary administration may not strand the final structurally active owner,
 *   so the last owner's role, suspension, and removal controls are all withdrawn
 *   rather than offered and then refused;
 * - a directory-owned lifetime is native read-only for suspension, reactivation,
 *   and removal, which happen at the source. Role stays native, because no
 *   external role is mapped automatically;
 * - Home `manageAllTeams` is not membership authority. Its single membership
 *   power is promoting an existing eligible non-guest member — never the caller,
 *   never a guest, never an inactive one — and only while the Team actually has
 *   no active owner;
 * - a management transfer needs somewhere to go. Returning to native management
 *   is always available for an externally owned lifetime, but binding a native
 *   one to a source requires an unbound provisioned identity in that source, so
 *   the capability follows the actual conversion target rather than being
 *   advertised and then refused.
 *
 * Like every projection this renders and prechecks; the mutation's transaction
 * re-decides with the same inputs.
 */
export function resolveTeamMemberTargetCapabilities(
    input: Readonly<{
        actor: TeamMemberActorFacts;
        target: TeamMemberTargetFacts;
        teamArchivedAt: Date | null;
        /** Count of structurally active owners currently in the Team. */
        activeOwnerCount: number;
    }>,
): TeamMembershipCapabilitiesV1 {
    if (input.teamArchivedAt !== null) return NO_TARGET_CAPABILITIES;

    const recoverable = isHomeOwnerRecoveryPromotion(input);
    if (!input.actor.manageMembers) {
        return recoverable ? { ...NO_TARGET_CAPABILITIES, setRole: true, assignableRoles: [TeamRole.owner] } : NO_TARGET_CAPABILITIES;
    }

    if (input.target.role === TeamRole.owner && !input.actor.manageOwners) {
        return NO_TARGET_CAPABILITIES;
    }

    const lastActiveOwner = isStructurallyActiveOwner(input.target) && input.activeOwnerCount <= 1;
    const nativeLifecycle = !input.target.managedExternally;

    return {
        // Every role change for the final active owner is either a no-op or the
        // demotion that would strand the Team, so the control is withdrawn
        // instead of being offered and then refused after submission.
        setRole: !lastActiveOwner,
        assignableRoles: lastActiveOwner ? [] : [
            ...((input.actor.manageOwners && admitsNewTeamOwner(input.target)) || recoverable ? [TeamRole.owner] : []),
            TeamRole.admin, TeamRole.member, TeamRole.guest,
        ],
        suspend: nativeLifecycle
            && input.target.status === TeamMembershipStatus.active
            && !lastActiveOwner,
        reactivate: nativeLifecycle && input.target.status === TeamMembershipStatus.suspended,
        remove: nativeLifecycle && !lastActiveOwner,
        setManagement: input.target.managedExternally
            || input.target.managementTransferTargetAvailable,
    };
}
