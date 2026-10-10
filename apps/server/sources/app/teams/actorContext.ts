import { TeamAuthenticationPolicyV1Schema, type AuthTokenAuthenticationEvidenceV1 } from "@happier-dev/protocol";
import type { TeamCapabilitiesV1, TeamErrorCodeV1 } from "@happier-dev/protocol/teams";

import type { Tx } from "@/storage/inTx";
import { AccountStatus, TeamMembershipStatus, TeamRole } from "@/storage/enums.generated";
import {
    readHomeGovernanceAccountInTx,
    resolveHomeGovernanceAuthority,
    type HomeGovernanceAuthority,
} from "@/app/home/governance/homeCapabilities";

import { resolveTeamCapabilitiesV1, resolveTeamMembershipCapabilitiesV1 } from "./capabilities";
import { projectTeamPolicyV1, TEAM_PROJECTION_SELECT, type TeamRecord } from "./projections";
import {
    qualifyTeamAuthenticationInTx,
    qualifyTeamAuthenticationsInTx,
} from "@/app/auth/entry/qualifyTeamAuthentication";

export type TeamOperationAuthenticationContext = Readonly<{
    env?: NodeJS.ProcessEnv;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    authenticationAuthority: "present_user" | "account_automation";
    legacyHomeCredential?: boolean;
}>;

export function readTeamOperationAuthenticationFromRequest(request: Readonly<{
    authAuthority?: "present_user" | "account_automation";
    authTokenLegacy?: boolean;
    authTokenAuthenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>, env: NodeJS.ProcessEnv = process.env): TeamOperationAuthenticationContext & Readonly<{ env: NodeJS.ProcessEnv }> {
    if (!request.authAuthority) {
        throw new Error("Verified request authentication authority is unavailable");
    }
    return {
        env,
        authenticationEvidence: request.authTokenAuthenticationEvidence,
        authenticationAuthority: request.authAuthority,
        legacyHomeCredential: request.authTokenLegacy === true,
    };
}

/**
 * The one lookup every Team service performs before it decides anything.
 *
 * Team lifecycle, policy, branding, membership, Groups, invitations, directory
 * administration, and the managed-identity surfaces all ask the same question:
 * does this Team exist, is this Account currently able to act on it, and with
 * which capabilities. Answering it once — one Team read, one Account read, one
 * membership read, one call to the shared capability owner — is what makes
 * "capabilities are re-read at the transaction that decides" a property of the
 * code rather than a convention each service must remember. Two resolvers for
 * this question could observe different transaction state and reach different
 * answers about the same actor, which is precisely the split brain this file
 * exists to prevent.
 *
 * The capability decision itself is not made here. `resolveTeamCapabilitiesV1`
 * remains the single owner of the role-and-authority mapping; this module owns
 * only the reads it needs and the shape its consumers share.
 *
 * Home authority is carried separately from the membership capabilities it
 * cannot confer. `capabilities` already composes the Home's Team-metadata
 * authority; `homeAuthority` is retained so a service can check the narrow
 * owner-required recovery power, which is deliberately never projected as
 * `manageMembers`.
 */
export type TeamActorContext = Readonly<{
    /** The full Team record, so no consumer needs a second read of the same row. */
    team: TeamRecord;
    actorAccountId: string;
    accountStatus: AccountStatus;
    /** The actor's own membership, or null when the actor is not a member. */
    membership: Readonly<{
        id: string;
        role: TeamRole;
        status: TeamMembershipStatus;
        managedExternally: boolean;
    }> | null;
    homeAuthority: HomeGovernanceAuthority;
    /** Team-membership authority before the independent Home detail/lifecycle arm is composed. */
    teamCapabilities: TeamCapabilitiesV1;
    capabilities: TeamCapabilitiesV1;
    /**
     * Whether the roster and Groups of this Team are readable by this actor.
     *
     * Ordinarily that is membership `viewTeam`. The one addition is the Home
     * administrator recovering an ownerless Team: the projection advertises
     * `recovery.canAppointOwner` to exactly that actor, so the reads that
     * journey needs admit them for exactly as long as the Team has no owner.
     * It is a read admission only — what they may then change stays with the
     * per-membership decision owner.
     */
    readsTeamForRecovery: boolean;
    /**
     * The Team has no structurally active owner right now.
     *
     * It is resolved with the rest of the context because every consumer that
     * projects a Team already holds this transaction, and because it must be
     * the same reading the owner-required recovery decision uses. It is a Team
     * condition, never a capability: what this actor may do about it stays with
     * the per-membership decision owner.
     */
    ownerRequired: boolean;
    activeOwnerCount: number;
}>;

/**
 * Resolve one actor's current authority over one Team.
 *
 * Returns `null` only when the Team does not exist. An actor with no membership
 * and no Home authority is a real context with denied capabilities, not an
 * absence: that distinction is what lets a mutation answer "this Team is
 * archived" to a retained member and "no such Team" to everyone else, and what
 * lets the owner-required recovery path see a Home administrator who is
 * deliberately not a member.
 *
 * Consumers that must not distinguish an unreadable Team from an absent one
 * collapse the two through `toTeamViewer`, which is the only place that
 * translation lives.
 */
export async function resolveTeamActorContextInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string }>,
): Promise<TeamActorContext | null> {
    const team = await tx.team.findUnique({
        where: { id: input.teamId },
        select: TEAM_PROJECTION_SELECT,
    });
    if (!team) return null;
    return resolveTeamActorContextForTeamInTx(tx, { team, actorAccountId: input.actorAccountId });
}

/** Resolves one actor across a bounded Team page without repeating Account,
 * membership, Team, or active-owner reads per resource row. */
export async function resolveTeamActorContextsInTx(
    tx: Tx,
    input: Readonly<{ teamIds: readonly string[]; actorAccountId: string }>,
): Promise<ReadonlyMap<string, TeamActorContext>> {
    const teamIds = [...new Set(input.teamIds)];
    if (teamIds.length === 0) return new Map();
    const [teams, account, memberships, ownerRows] = await Promise.all([
        tx.team.findMany({ where: { id: { in: teamIds } }, select: TEAM_PROJECTION_SELECT }),
        readHomeGovernanceAccountInTx(tx, input.actorAccountId),
        tx.teamMembership.findMany({
            where: { teamId: { in: teamIds }, accountId: input.actorAccountId },
            select: { id: true, teamId: true, role: true, status: true,
                provisionedIdentity: { select: { id: true } },
                identityConnectionManagement: { select: { teamMembershipId: true } } },
        }),
        tx.teamMembership.findMany({
            where: {
                teamId: { in: teamIds }, role: TeamRole.owner, status: TeamMembershipStatus.active,
                account: { status: AccountStatus.active },
            },
            select: { teamId: true },
        }),
    ]);
    const membershipByTeam = new Map(memberships.map(({ teamId, provisionedIdentity, identityConnectionManagement, ...membership }) => [teamId, {
        ...membership, managedExternally: provisionedIdentity !== null || identityConnectionManagement !== null,
    }] as const));
    const ownerCounts = new Map<string, number>();
    for (const row of ownerRows) ownerCounts.set(row.teamId, (ownerCounts.get(row.teamId) ?? 0) + 1);
    const accountStatus = account?.status ?? AccountStatus.disabled;
    const homeAuthority = resolveHomeGovernanceAuthority(account);
    return new Map(teams.map(team => [team.id, composeTeamActorContext({
        team, actorAccountId: input.actorAccountId, accountStatus,
        membership: membershipByTeam.get(team.id) ?? null, homeAuthority,
        ownerRequired: (ownerCounts.get(team.id) ?? 0) === 0,
        activeOwnerCount: ownerCounts.get(team.id) ?? 0,
    })]));
}

/**
 * Qualify an already-authorized Team operation against the current credential.
 *
 * Callers resolve `TeamActorContext` and establish the operation's capability
 * first. That ordering prevents an actor who lacks the Team-derived entitlement
 * from probing its authentication policy. A restricted Team then requires the
 * exact credential admitted by the shared authentication owner; callers never
 * infer qualification from linked identity or membership provenance.
 *
 * Home-governance and owner-recovery operations do not call this function: they
 * use independent structural authority, so there is no Team-derived authority
 * to qualify. The sole bypass here is an exact malformed authentication-policy
 * repair; the policy owner separately proves this is a replacement-only patch
 * with the client's observed repair basis before opting into it.
 */
export async function qualifyTeamOperationAuthenticationInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{
        context: TeamActorContext;
        allowMalformedAuthenticationPolicyRepair?: boolean;
    }>,
): Promise<
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: Extract<TeamErrorCodeV1,
        "team_authentication_required" | "team_authentication_unavailable"
    > }>
> {
    const { context } = input;
    if (input.legacyHomeCredential === true) {
        return { ok: false, error: "team_authentication_unavailable" };
    }
    if (input.authenticationEvidence !== undefined && !input.authenticationAuthority) {
        return { ok: false, error: "team_authentication_unavailable" };
    }
    if (input.allowMalformedAuthenticationPolicyRepair === true
        && context.team.authenticationPolicy !== null
        && !TeamAuthenticationPolicyV1Schema.safeParse(context.team.authenticationPolicy).success) {
        return { ok: true };
    }

    const qualification = await qualifyTeamAuthenticationInTx(tx, {
        env: input.env ?? process.env,
        team: context.team,
        accountId: context.actorAccountId,
        verifiedCredentialEvidence: input.authenticationEvidence,
        // A direct owner-level call with no credential evidence is an unqualified
        // present-user attempt. Evidence-bearing callers cannot omit the verified
        // authority: that case failed closed above rather than being restamped.
        operationContext: { kind: input.authenticationAuthority ?? "present_user" },
    });
    if (qualification.status === "satisfied") return { ok: true };
    return qualification.status === "authentication_required"
        ? { ok: false, error: "team_authentication_required" }
        : { ok: false, error: "team_authentication_unavailable" };
}

/** Applies the canonical credential qualification to a bounded Team-context
 * page while preserving the operation adapter's exact fail-closed contract. */
export async function qualifyTeamOperationAuthenticationsInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{
        contexts: readonly TeamActorContext[];
    }>,
): Promise<ReadonlyMap<string, Readonly<{ ok: true }> | Readonly<{
    ok: false;
    error: Extract<TeamErrorCodeV1,
        "team_authentication_required" | "team_authentication_unavailable">;
    }>>> {
    const contexts = [...new Map(input.contexts.map((context) => [context.team.id, context])).values()];
    if (input.legacyHomeCredential === true
        || (input.authenticationEvidence !== undefined && !input.authenticationAuthority)) {
        return new Map(contexts.map((context) => [context.team.id, {
            ok: false as const,
            error: "team_authentication_unavailable" as const,
        }]));
    }
    const actorAccountId = contexts[0]?.actorAccountId ?? "";
    if (contexts.some((context) => context.actorAccountId !== actorAccountId)) {
        return new Map(contexts.map((context) => [context.team.id, {
            ok: false as const,
            error: "team_authentication_unavailable" as const,
        }]));
    }
    const qualifications = await qualifyTeamAuthenticationsInTx(tx, {
        env: input.env ?? process.env,
        teams: contexts.map((context) => context.team),
        accountId: actorAccountId,
        verifiedCredentialEvidence: input.authenticationEvidence,
        // Same default as the scalar entry point: a direct owner-level call with
        // no credential evidence is an unqualified present-user attempt, while
        // an evidence-bearing caller without a verified authority already failed
        // closed above.
        operationContext: { kind: input.authenticationAuthority ?? "present_user" },
    });
    return new Map(contexts.map((context) => {
        const qualification = qualifications.get(context.team.id) ?? { status: "unavailable" as const };
        return [context.team.id, qualification.status === "satisfied"
            ? { ok: true as const }
            : {
                ok: false as const,
                error: qualification.status === "authentication_required"
                    ? "team_authentication_required" as const
                    : "team_authentication_unavailable" as const,
            }] as const;
    }));
}

/**
 * Qualify the Team summary read that carries an administrator to policy repair.
 *
 * A malformed stored policy cannot be satisfied by any credential, but hiding
 * it from the Team owners who can replace it would also hide the sole canonical
 * recovery surface. The exception is therefore limited to a structurally active
 * Team owner/admin (`manageAuthentication`) reading the already-redacted Team
 * projection. Every mutation and every nested/protected resource read continues
 * through the ordinary fail-closed qualification owner above.
 */
export async function qualifyTeamProjectionReadAuthenticationInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{
        context: TeamActorContext;
    }>,
): Promise<
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: Extract<TeamErrorCodeV1,
        "team_authentication_required" | "team_authentication_unavailable"
    > }>
> {
    if (isTeamAuthenticationPolicyRepairRead(input.context)) {
        return { ok: true };
    }
    return qualifyTeamOperationAuthenticationInTx(tx, input);
}

function isTeamAuthenticationPolicyRepairRead(context: TeamActorContext): boolean {
    return context.teamCapabilities.manageAuthentication
        && projectTeamPolicyV1(context.team).authenticationPolicyStatus === "repair_required";
}

/**
 * The same projection-read resolution for a bounded page of Team contexts.
 *
 * The directory reads a whole page at once, so qualifying row by row issues one
 * authentication fact query per Team for a decision the batch owner already
 * answers in one. The repair exception stays row-local because it is decided
 * from the row's own capabilities and stored policy.
 */
export async function qualifyTeamProjectionReadAuthenticationsInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{
        contexts: readonly TeamActorContext[];
    }>,
): Promise<ReadonlyMap<string, Readonly<{ ok: true }> | Readonly<{
    ok: false;
    error: Extract<TeamErrorCodeV1,
        "team_authentication_required" | "team_authentication_unavailable">;
    }>>> {
    const results = new Map<string, Readonly<{ ok: true }> | Readonly<{
        ok: false;
        error: Extract<TeamErrorCodeV1,
            "team_authentication_required" | "team_authentication_unavailable">;
    }>>();
    const qualifiable: TeamActorContext[] = [];
    for (const context of input.contexts) {
        if (isTeamAuthenticationPolicyRepairRead(context)) {
            results.set(context.team.id, { ok: true });
            continue;
        }
        qualifiable.push(context);
    }
    if (qualifiable.length === 0) return results;
    const qualified = await qualifyTeamOperationAuthenticationsInTx(tx, { ...input, contexts: qualifiable });
    for (const [teamId, result] of qualified) results.set(teamId, result);
    return results;
}

/**
 * The same resolution for a Team row the caller already holds.
 *
 * A mutation that has just written the Team must project against the row it
 * committed, not against a re-read that could observe something else. That is
 * the only reason this entry point exists — it is the identical Account,
 * membership and capability composition, so a caller in that position composes
 * nothing itself.
 */
export async function resolveTeamActorContextForTeamInTx(
    tx: Tx,
    input: Readonly<{ team: TeamRecord; actorAccountId: string }>,
): Promise<TeamActorContext> {
    const { team } = input;

    // A missing Account row resolves to the same denied authority as an
    // inactive one. An authenticated actor whose Account was erased underneath
    // the request must not read as anything but powerless.
    const account = await readHomeGovernanceAccountInTx(tx, input.actorAccountId);
    const accountStatus = account?.status ?? AccountStatus.disabled;
    const homeAuthority = resolveHomeGovernanceAuthority(account);

    const membership = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: team.id, accountId: input.actorAccountId } },
        select: { id: true, role: true, status: true,
            provisionedIdentity: { select: { id: true } },
            identityConnectionManagement: { select: { teamMembershipId: true } } },
    });

    const activeOwnerCount = await countActiveTeamOwnersInTx(tx, { teamId: team.id });

    return composeTeamActorContext({
        team,
        actorAccountId: input.actorAccountId,
        accountStatus,
        membership: membership ? {
            id: membership.id, role: membership.role, status: membership.status,
            managedExternally: membership.provisionedIdentity !== null || membership.identityConnectionManagement !== null,
        } : null,
        homeAuthority,
        ownerRequired: activeOwnerCount === 0,
        activeOwnerCount,
    });
}

/** Compose the canonical context from facts a bounded query already owns. */
export function composeTeamActorContext(input: Readonly<{
    team: TeamRecord;
    actorAccountId: string;
    accountStatus: AccountStatus;
    membership: TeamActorContext["membership"];
    homeAuthority: HomeGovernanceAuthority;
    ownerRequired: boolean;
    activeOwnerCount: number;
}>): TeamActorContext {
    const teamCapabilities = resolveTeamMembershipCapabilitiesV1({
        accountStatus: input.accountStatus,
        membership: input.membership,
        teamArchivedAt: input.team.archivedAt,
    });
    const capabilities = resolveTeamCapabilitiesV1({
        accountStatus: input.accountStatus,
        homeAuthority: input.homeAuthority,
        membership: input.membership,
        teamArchivedAt: input.team.archivedAt,
        ownerRequired: input.ownerRequired,
        activeOwnerCount: input.activeOwnerCount,
    });
    return {
        ...input,
        teamCapabilities,
        capabilities,
        // The same decision the projection publishes, so a client gating on `viewRoster` and the
        // roster/Group reads gating here cannot disagree.
        readsTeamForRecovery: capabilities.viewRoster,
    };
}

/**
 * The number of structurally active owners: active Account, active membership,
 * owner role. Neither Team archive, authentication freshness, nor envelope
 * readiness belongs in this predicate — an archived Team still has its owners,
 * and a spurious owner-required state would invite an unnecessary Home
 * intervention.
 */
export async function countActiveTeamOwnersInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; excludeMembershipIds?: readonly string[] }>,
): Promise<number> {
    const excluded = input.excludeMembershipIds ?? [];
    return tx.teamMembership.count({
        where: {
            teamId: input.teamId,
            role: TeamRole.owner,
            status: TeamMembershipStatus.active,
            account: { status: AccountStatus.active },
            ...(excluded.length > 0 ? { id: { notIn: [...excluded] } } : {}),
        },
    });
}
