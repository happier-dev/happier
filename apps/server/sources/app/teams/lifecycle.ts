import { withTeamSessionAccessEffectsInTx } from "./memberships/sessionAccessEffects";
import { createHash } from "node:crypto";

import {
    NO_TEAM_CAPABILITIES_V1,
    type TeamSummaryV1,
    validateTeamDescriptionV1,
    validateTeamNameV1,
} from "@happier-dev/protocol/teams";

import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { readHomeGovernancePolicyInTx } from "@/app/home/governance/governancePolicy";
import {
    readHomeGovernanceAccountInTx,
    resolveHomeGovernanceAuthority,
    resolveHomeTeamCreationCapability,
} from "@/app/home/governance/homeCapabilities";
import type { Tx } from "@/storage/inTx";
import { defaultRepeatKeyExpiresAt, fetchRepeatKey, saveRepeatKey } from "@/storage/queue/repeatKey";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { AccountStatus } from "@/storage/enums.generated";

import { revokeActiveTeamInvitationsForTeamInTx } from "./invitations/invitationLifecycle";
import { admitTeamMemberInTx } from "./memberships/membershipService";
import { TEAM_PROJECTION_SELECT, projectTeamSummaryV1, type TeamRecord } from "./projections";
import { readTeamSummaryCountsInTx } from "./teamSummaryCounts";
import { publishTeamChangedInTx } from "./teamChanges";
import {
    qualifyTeamOperationAuthenticationInTx,
    qualifyTeamProjectionReadAuthenticationInTx,
    resolveTeamActorContextForTeamInTx,
    resolveTeamActorContextInTx,
    type TeamOperationAuthenticationContext,
    type TeamActorContext,
} from "./actorContext";
import { toTeamViewer } from "./viewer";
import { resolveTeamCapabilitiesV1 } from "./capabilities";

/**
 * The one Team lifecycle service.
 *
 * Every route, provisioning adapter, Home-administration action, and operator
 * adapter creates, renames, archives, and restores a Team through these
 * functions. Nothing else writes the Team's lifecycle columns, which is what
 * keeps archive semantics, invitation revocation, and invalidation from
 * drifting apart across callers. Policy and branding retain their separate
 * field-level owners on the same row.
 *
 * Each mutation re-reads the actor's Account lifecycle, Home authority, Team
 * membership, and the Team's archived state inside the caller's serializable
 * transaction. A capability projection the client rendered a minute ago is a
 * hint; only this re-read decides.
 */

export type TeamLifecycleError =
    | "invalid_team_input"
    | "team_forbidden"
    | "team_not_found"
    | "teams_unavailable"
    | "team_archived"
    | "team_authentication_required"
    | "team_authentication_unavailable"
    | "team_authentication_policy_unavailable"
    | "team_conflict";

export type TeamLifecycleResult<E extends TeamLifecycleError = TeamLifecycleError> =
    | Readonly<{ ok: true; team: TeamSummaryV1 }>
    | Readonly<{ ok: false; error: E }>;

function denied<E extends TeamLifecycleError>(error: E): Readonly<{ ok: false; error: E }> {
    return { ok: false, error };
}

export type CreateTeamError =
    | "invalid_team_input"
    | "team_forbidden"
    | "teams_unavailable"
    | "team_authentication_required"
    | "team_authentication_unavailable"
    | "team_conflict";

export type CreateTeamInput = Readonly<{
    actorAccountId: string;
    name: string;
    description?: string | null;
    /**
     * Stable identity supplied only by a trusted internal composition whose
     * product contract already owns that Team identity. Public Actions and
     * routes must never project caller input into this field.
     */
    internalTeamId?: string;
    /**
     * The Account that becomes the Team's first owner. Absent means the actor.
     * A Home administrator creating a managed Team for somebody else supplies it
     * and does **not** become a member: Home governance authorizes governance,
     * never membership or content.
     */
    initialOwnerAccountId?: string;
    /** The caller's own retry identity, so a lost response cannot create two Teams. */
    requestKey: string;
    env?: NodeJS.ProcessEnv;
    authentication?: TeamOperationAuthenticationContext;
}>;

/**
 * The dedupe record for one create intent.
 *
 * It is keyed by actor and caller request key, and its value binds the exact
 * payload to the Team that was created. A retry of the same intent returns that
 * Team; the same key carrying a different payload is a client error rather than
 * a silent second creation or a silent overwrite of the first one. This uses the
 * existing repeat-key facility scoped to this operation — not a general Action
 * ledger, which nothing here needs.
 */
function createRequestKey(actorAccountId: string, requestKey: string): string {
    return `teams.create:${actorAccountId}:${requestKey}`;
}

function createPayloadDigest(input: Readonly<{
    name: string;
    description: string | null;
    initialOwnerAccountId: string;
    internalTeamId: string | null;
}>): string {
    return createHash("sha256")
        .update(JSON.stringify([
            input.name,
            input.description,
            input.initialOwnerAccountId,
            input.internalTeamId,
        ]))
        .digest("base64url");
}

export async function createTeamInTx(
    tx: Tx,
    input: CreateTeamInput,
): Promise<TeamLifecycleResult<CreateTeamError>> {
    const teamsEnabled = await isServerFeatureEnabledForHome("teams", { tx, env: input.env });
    if (!teamsEnabled) return denied("teams_unavailable");

    const name = validateTeamNameV1(input.name);
    if (name.status !== "ok") return denied("invalid_team_input");
    const description = validateTeamDescriptionV1(input.description);
    if (description.status !== "ok") return denied("invalid_team_input");

    const actor = await readHomeGovernanceAccountInTx(tx, input.actorAccountId);
    if (!actor || actor.status !== AccountStatus.active) return denied("team_forbidden");

    const policy = await readHomeGovernancePolicyInTx(tx);
    const mayCreate = resolveHomeTeamCreationCapability({
        account: actor,
        teamCreationPolicy: policy.teamCreationPolicy,
        teamsEnabled,
    });
    if (!mayCreate) return denied("team_forbidden");

    // Under `managed_only` the creator is provisioning a Team for somebody, and
    // the product asks them to choose who. Silently falling back to the creator
    // would make a Home administrator the owner of a Team they were creating for
    // another person. Naming themselves stays legal; self-service creation keeps
    // the fallback, and bootstrap already passes the owner explicitly.
    if (policy.teamCreationPolicy === "managed_only" && input.initialOwnerAccountId === undefined) {
        return denied("invalid_team_input");
    }

    const authority = resolveHomeGovernanceAuthority(actor);
    const initialOwnerAccountId = input.initialOwnerAccountId ?? actor.accountId;
    if (initialOwnerAccountId !== actor.accountId && !authority.manageAllTeams) {
        // Creating a Team owned by somebody else is managed creation, which is a
        // Home-administration act. Ordinary self-service creation may only make
        // the creator the owner.
        return denied("team_forbidden");
    }

    // Checked before the Team row exists: an initial owner who has been erased or
    // disabled since the picker rendered must fail as input, not as a Team that
    // briefly existed without an owner.
    const initialOwner = await readHomeGovernanceAccountInTx(tx, initialOwnerAccountId);
    if (!initialOwner || initialOwner.status !== AccountStatus.active) return denied("invalid_team_input");

    const dedupeKey = createRequestKey(actor.accountId, input.requestKey);
    const digest = createPayloadDigest({
        name: name.name,
        description: description.description,
        initialOwnerAccountId,
        internalTeamId: input.internalTeamId ?? null,
    });
    const now = await readTransactionDatabaseTime(tx);
    const recorded = await fetchRepeatKey(tx, dedupeKey, now);
    if (recorded !== null) {
        const [recordedDigest, recordedTeamId] = recorded.split(":");
        if (recordedDigest !== digest || !recordedTeamId) return denied("team_conflict");
        const replayed = await readTeamSummaryForActorInTx(tx, {
            teamId: recordedTeamId,
            actorAccountId: actor.accountId,
            authentication: input.authentication,
        });
        // The recorded Team can legitimately be gone from this actor's view — it
        // may have been archived, or created for somebody else. A retry that can
        // no longer read it is still not permission to create a second Team.
        if (!replayed.ok) {
            if (replayed.error === "team_not_found") return denied("team_conflict");
            return denied(replayed.error);
        }
        return replayed;
    }

    const created = await tx.team.create({
        data: {
            ...(input.internalTeamId === undefined ? {} : { id: input.internalTeamId }),
            name: name.name,
            ...(description.description === null ? {} : { description: description.description }),
        },
        select: TEAM_PROJECTION_SELECT,
    });

    // The Team and its first owner commit together or not at all: a Team with no
    // owner has no one who can administer or delete it. Eligibility was already
    // checked, so a failure here is a concurrent lifecycle change and the whole
    // transaction must roll back rather than leave an ownerless Team behind.
    const owner = await admitTeamMemberInTx(tx, {
        teamId: created.id,
        accountId: initialOwnerAccountId,
        role: "owner",
        // A new Team has no prior Sessions, so there is nothing for a cutoff to
        // withhold from its founder; a horizon here would be a fiction.
        historyAccess: "all_existing",
        env: input.env,
    });
    if (!owner.ok) throw new Error(`Team initial owner could not be admitted: ${owner.error}`);

    // Retention uses the same transaction clock the lookup used, so the window a
    // retry can land in is not split across two clocks.
    await saveRepeatKey(tx, dedupeKey, `${digest}:${created.id}`, defaultRepeatKeyExpiresAt(now));
    await publishTeamChangedInTx(tx, { teamId: created.id, additionalAccountIds: [actor.accountId] });

    return { ok: true, team: await projectForActorInTx(tx, created, actor.accountId, input.authentication) };
}

export type UpdateTeamInput = Readonly<{
    actorAccountId: string;
    teamId: string;
    name?: string;
    description?: string | null;
    env?: NodeJS.ProcessEnv;
    authentication?: TeamOperationAuthenticationContext;
}>;

/** Team metadata. Branding and policy have their own owners and capabilities. */
export async function updateTeamInTx(tx: Tx, input: UpdateTeamInput): Promise<TeamLifecycleResult> {
    if (!await isServerFeatureEnabledForHome("teams", { tx, env: input.env })) return denied("teams_unavailable");
    const context = await resolveTeamActorContextInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
    });
    const viewer = toTeamViewer(context);
    if (viewer === null) return denied("team_not_found");
    if (!viewer.capabilities.manageSettings) {
        // `restoreTeam` is exactly the set that would hold `manageSettings` if the
        // Team were active, so "archived" is reported only where it is the real
        // reason rather than a hint that restoring would grant access.
        const archived = viewer.team.archivedAt !== null;
        return denied(archived && viewer.capabilities.restoreTeam ? "team_archived" : "team_forbidden");
    }
    if (!context!.homeAuthority.manageAllTeams) {
        const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
            context: context!,
            ...input.authentication,
        });
        if (!qualification.ok) return denied(qualification.error);
    }

    const data: { name?: string; description?: string | null } = {};
    if (input.name !== undefined) {
        const name = validateTeamNameV1(input.name);
        if (name.status !== "ok") return denied("invalid_team_input");
        data.name = name.name;
    }
    if (input.description !== undefined) {
        const description = validateTeamDescriptionV1(input.description);
        if (description.status !== "ok") return denied("invalid_team_input");
        data.description = description.description;
    }
    if (data.name === undefined && data.description === undefined) return denied("invalid_team_input");

    const updated = await tx.team.update({
        where: { id: input.teamId },
        data,
        select: TEAM_PROJECTION_SELECT,
    });
    await publishTeamChangedInTx(tx, { teamId: input.teamId });
    return { ok: true, team: await projectForActorInTx(tx, updated, input.actorAccountId, input.authentication) };
}

export type ArchiveTeamInput = Readonly<{
    actorAccountId: string;
    teamId: string;
    env?: NodeJS.ProcessEnv;
    authentication?: TeamOperationAuthenticationContext;
}>;

/**
 * Archive is the one reversible lifecycle fact.
 *
 * It retains every row — memberships, Groups, policies, the logo, and downstream
 * grants — while each downstream evaluator stops treating Team- and
 * Group-derived access as effective. Outstanding invitations are revoked in this
 * same transaction, because a link that survived archive would readmit people to
 * a Team nobody is administering.
 *
 * Archiving an archived Team is a no-op that still re-checks authorization, so a
 * retry cannot be used to learn anything a first call would not have told the
 * caller.
 */
export async function archiveTeamInTx(tx: Tx, input: ArchiveTeamInput): Promise<TeamLifecycleResult> {
    if (!await isServerFeatureEnabledForHome("teams", { tx, env: input.env })) return denied("teams_unavailable");
    const context = await resolveTeamActorContextInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
    });
    const viewer = toTeamViewer(context);
    if (viewer === null) return denied("team_not_found");

    if (viewer.team.archivedAt !== null) {
        // Already archived. Archive withdraws `archiveTeam` from everyone, so the
        // unchanged answer is authorized against the capability that survives
        // archive for the same administrators: a member who could not restore it
        // could not have archived it either.
        if (!viewer.capabilities.restoreTeam) return denied("team_forbidden");
        if (!context!.homeAuthority.manageAllTeams) {
            const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
                context: context!,
                ...input.authentication,
            });
            if (!qualification.ok) return denied(qualification.error);
        }
        return { ok: true, team: await projectForActorInTx(tx, viewer.team, input.actorAccountId, input.authentication) };
    }
    if (!viewer.capabilities.archiveTeam) return denied("team_forbidden");
    if (!context!.homeAuthority.manageAllTeams) {
        const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
            context: context!,
            ...input.authentication,
        });
        if (!qualification.ok) return denied(qualification.error);
    }

    const now = await readTransactionDatabaseTime(tx);
    return withTeamSessionAccessEffectsInTx(tx, { teamId: input.teamId, origin: "retained_lifecycle" }, async () => {
        const archived = await tx.team.update({
            where: { id: input.teamId },
            data: { archivedAt: now },
            select: TEAM_PROJECTION_SELECT,
        });
        await revokeActiveTeamInvitationsForTeamInTx(tx, { teamId: input.teamId, now });
        await publishTeamChangedInTx(tx, { teamId: input.teamId });

        return { ok: true, team: await projectForActorInTx(tx, archived, input.actorAccountId, input.authentication) };
    });
}

export type RestoreTeamInput = Readonly<{
    actorAccountId: string;
    teamId: string;
    env?: NodeJS.ProcessEnv;
    authentication?: TeamOperationAuthenticationContext;
}>;

/**
 * Restore re-enables the retained Team, its memberships, its Groups, and its
 * policies prospectively. It deliberately does not resurrect revoked invitations
 * and does not recreate removed members or rotate keys.
 */
export async function restoreTeamInTx(tx: Tx, input: RestoreTeamInput): Promise<TeamLifecycleResult> {
    if (!await isServerFeatureEnabledForHome("teams", { tx, env: input.env })) return denied("teams_unavailable");
    const context = await resolveTeamActorContextInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
    });
    const viewer = toTeamViewer(context);
    if (viewer === null) return denied("team_not_found");

    if (viewer.team.archivedAt === null) {
        // Already active. `restoreTeam` is false for an active Team, so the
        // unchanged answer is authorized against the capability an administrator
        // holds while it is active.
        if (!viewer.capabilities.archiveTeam) return denied("team_forbidden");
        if (!context!.homeAuthority.manageAllTeams) {
            const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
                context: context!,
                ...input.authentication,
            });
            if (!qualification.ok) return denied(qualification.error);
        }
        return { ok: true, team: await projectForActorInTx(tx, viewer.team, input.actorAccountId, input.authentication) };
    }
    if (!viewer.capabilities.restoreTeam) return denied("team_forbidden");
    if (!context!.homeAuthority.manageAllTeams) {
        const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
            context: context!,
            ...input.authentication,
        });
        if (!qualification.ok) return denied(qualification.error);
    }

    // Restoration re-enables exactly the retained memberships, Groups and grants
    // it paused, so it is not a qualifying transition for prospective auto-follow.
    return withTeamSessionAccessEffectsInTx(tx, { teamId: input.teamId, origin: "retained_lifecycle" }, async () => {
        const restored = await tx.team.update({
            where: { id: input.teamId },
            data: { archivedAt: null },
            select: TEAM_PROJECTION_SELECT,
        });
        await publishTeamChangedInTx(tx, { teamId: input.teamId });

        return { ok: true, team: await projectForActorInTx(tx, restored, input.actorAccountId, input.authentication) };
    });
}

/**
 * Projects a Team the caller has already loaded and authorized, re-resolving the
 * actor's capabilities against the row's post-mutation state so the result a
 * client renders is the state the transaction actually committed.
 */
export async function projectForActorInTx(
    tx: Tx,
    team: TeamRecord,
    actorAccountId: string,
    authentication?: TeamOperationAuthenticationContext,
): Promise<TeamSummaryV1> {
    const context = await resolveTeamActorContextForTeamInTx(tx, { team, actorAccountId });
    return (await projectQualifiedTeamContextInTx(tx, context, authentication)).team;
}

async function projectQualifiedTeamContextInTx(
    tx: Tx,
    context: TeamActorContext,
    authentication?: TeamOperationAuthenticationContext,
) {
    const qualification = context.teamCapabilities.viewTeam || !context.homeAuthority.manageAllTeams
        ? await qualifyTeamProjectionReadAuthenticationInTx(tx, { context, ...authentication })
        : { ok: true as const };
    const counts = await readTeamSummaryCountsInTx(tx, [context.team.id]);
    return {
        qualification,
        team: projectTeamSummaryV1({
            counts: counts.get(context.team.id)!,
            teamCapabilities: qualification.ok ? context.teamCapabilities : NO_TEAM_CAPABILITIES_V1,
            team: context.team,
            viewerRole: context.membership?.role ?? null,
            capabilities: qualification.ok ? context.capabilities : resolveTeamCapabilitiesV1({
                accountStatus: context.accountStatus,
                homeAuthority: context.homeAuthority,
                membership: null,
                teamArchivedAt: context.team.archivedAt,
                ownerRequired: context.ownerRequired,
            }),
            ownerRequired: context.ownerRequired,
            homeAuthority: context.homeAuthority,
        }),
    };
}

/** `teams.get`: the canonical readable projection, or `null` when unreadable. */
export async function readTeamSummaryForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamLifecycleResult<
    "team_not_found" | "team_authentication_required" | "team_authentication_unavailable"
>> {
    const context = await resolveTeamActorContextInTx(tx, input);
    const viewer = toTeamViewer(context);
    if (viewer === null) return denied("team_not_found");
    const projected = await projectQualifiedTeamContextInTx(tx, context!, input.authentication);
    if (!context!.homeAuthority.manageAllTeams && !projected.qualification.ok) {
        return denied(projected.qualification.error);
    }
    return { ok: true, team: projected.team };
}
