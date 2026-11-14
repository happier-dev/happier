import { validateTeamGroupNameV1 } from "@happier-dev/protocol/teams";

import type { Tx } from "@/storage/inTx";
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication } from "@/app/changes/markAccountChanged";
import { acquireTeamMutationAccountAdmissionInTx, withTeamSessionAccessEffectsInTx, type TeamSessionAccessImpacts } from "./sessionAccessEffects";
import {
    TeamExternalGroupBindingMode,
    TeamMembershipStatus,
    TeamRole,
    type SessionHistoryAccess,
} from "@/storage/enums.generated";
import {
    applyTeamGroupContributionInTx,
    type TeamGroupContributionOutcome,
} from "../groups/groupContributions";
import { publishTeamChangedInTx } from "../teamChanges";
import { admitTeamMemberInTx, setTeamMembershipStatusInTx } from "./membershipService";
import { revokeTeamCredentialExternalApiKeysForMembershipInTx } from "../credentials/externalApiKey";
import { revokeTeamCredentialAudienceForMembershipInTx } from "../credentials/resourceAudience";
import { prepareTeamGroupNameForAutomatedWriteInTx } from "../groups/privateLabels";

/**
 * The external-fact transaction seam.
 *
 * These four adapters are the *only* way an enterprise directory changes native
 * Team authorization. They delegate to the same membership and Group-contribution
 * owners the native UI uses, which is what makes "one membership writer" a
 * property of the code rather than a convention each reconciler must remember.
 *
 * Every adapter takes the caller's existing transaction. The caller prepares
 * complete evidence outside it and applies the whole set inside one transaction,
 * so an initial import or a source revocation is never observable as partially
 * committed native access. No adapter starts its own transaction, calls an
 * external API, or returns a cursor for "the rest of the access changes".
 *
 * External state is provenance, never authorization: nothing here reads a
 * provider claim, an eligibility status, or a directory projection to decide
 * whether access is permitted. It decides only which canonical row a confirmed
 * external observation maps to.
 */

/** Which Lane 03 owner is speaking. Both kinds can own Group bindings today. */
export type ExternalFactOwner =
    | Readonly<{ kind: "directory_source"; directorySourceId: string }>
    | Readonly<{ kind: "identity_connection"; teamIdentityConnectionId: string }>;

/** Exact external owner of this one membership mutation. */
export type ExternalMemberSource =
    | Readonly<{
        kind: "directory_source";
        directorySourceId: string;
        externalUserId: string;
    }>
    | Readonly<{
        kind: "identity_connection";
        teamIdentityConnectionId: string;
    }>;

export type ExternalMembershipDesiredState = "active" | "suspended" | "absent";

export type ExternalMembershipResult =
    | Readonly<{
        status: "applied" | "unchanged";
        teamMembershipId: string | null;
        accountId: string;
    }>
    /**
     * The membership exists and is managed by native administration or by a
     * different source. This source contributes no lifetime change, and the
     * membership it names stays exactly as it is. It is deliberately not a
     * conflict: a second directory that observes the same person still has
     * valid Group evidence for that membership.
     */
    | Readonly<{ status: "managed_elsewhere"; teamMembershipId: string }>
    /** The source's own binding is corrupt — it names somebody else's row. */
    | Readonly<{ status: "management_conflict" }>
    | Readonly<{ status: "team_archived" }>
    | Readonly<{ status: "source_not_found" }>;

async function readSourceInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; directorySourceId: string }>,
): Promise<boolean> {
    const source = await tx.teamDirectorySource.findUnique({
        where: { id: input.directorySourceId },
        select: { teamId: true },
    });
    // The source's own row proves which Team it may write to. A caller-asserted
    // Team is a claim, and a source from another Team must not reach this one.
    return source?.teamId === input.teamId;
}

/**
 * Apply one confirmed external membership observation.
 *
 * Ownership is the load-bearing rule. A membership this source already owns is
 * updated; a native membership, or one owned by a different source, is reported
 * as a conflict and left exactly as it is. That is what stops a reconciler from
 * silently taking over offboarding authority for somebody an administrator
 * added by hand — the deliberate conversion has its own explicit action.
 *
 * A directory activation always admits at `member`. Provider roles never map to
 * Team owner or admin without an explicitly approved mapping, and there is none.
 */
export async function applyExternalTeamMembershipInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        accountId: string;
        source: ExternalMemberSource;
        desired: ExternalMembershipDesiredState;
        /**
         * Legacy prepared hint, intentionally ignored. The current Team default
         * is reread by this final transaction before a lifetime is minted.
         */
        historyAccess: SessionHistoryAccess;
        sessionAccessImpacts?: TeamSessionAccessImpacts;
        /** `false` lets a set-oriented caller publish once for its whole batch. */
        publishChange?: boolean;
    }>,
): Promise<ExternalMembershipResult> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.accountId], affectedAccountIds: [input.accountId], membershipChange: { kind: "teamMembership", teamId: input.teamId } });
    if (input.source.kind === "directory_source") {
        if (!await readSourceInTx(tx, {
            teamId: input.teamId,
            directorySourceId: input.source.directorySourceId,
        })) return { status: "source_not_found" };
    } else {
        const connection = await tx.teamIdentityConnection.findUnique({
            where: { id: input.source.teamIdentityConnectionId },
            select: { teamId: true },
        });
        if (connection?.teamId !== input.teamId) return { status: "source_not_found" };
    }
    const team = await tx.team.findUnique({
        where: { id: input.teamId },
        select: { defaultSessionHistoryAccess: true },
    });
    if (!team) return { status: "source_not_found" };

    const identity = input.source.kind === "directory_source"
        ? await tx.teamProvisionedIdentity.findUnique({
            where: {
                directorySourceId_externalUserId: {
                    directorySourceId: input.source.directorySourceId,
                    externalUserId: input.source.externalUserId,
                },
            },
            select: { id: true, boundAccountId: true, teamMembershipId: true },
        })
        : null;
    if (input.source.kind === "directory_source" && !identity) return { status: "source_not_found" };
    if (identity && identity.boundAccountId !== input.accountId) return { status: "management_conflict" };

    const existing = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: input.teamId, accountId: input.accountId } },
        select: {
            id: true,
            status: true,
            provisionedIdentity: { select: { id: true } },
            identityConnectionManagement: { select: { teamIdentityConnectionId: true } },
        },
    });

    if (existing) {
        // A manager pointer that names a different Account's membership is a
        // corrupt binding, not a second manager, and must not be written past.
        if (
            input.source.kind === "directory_source"
            && identity!.teamMembershipId !== null
            && identity!.teamMembershipId !== existing.id
        ) return { status: "management_conflict" };
        const ownsLifetime = input.source.kind === "directory_source"
            ? existing.id === identity?.teamMembershipId
                && existing.identityConnectionManagement === null
            : existing.provisionedIdentity === null
                && existing.identityConnectionManagement?.teamIdentityConnectionId
                    === input.source.teamIdentityConnectionId;
        // Somebody else owns this lifetime. The source neither seizes it nor
        // ends it: a source cannot offboard a person it did not admit. It
        // reports the membership so the caller can still consume the source's
        // own Group evidence against it.
        if (!ownsLifetime) {
            return input.desired === "absent"
                ? { status: "unchanged", teamMembershipId: existing.id, accountId: input.accountId }
                : { status: "managed_elsewhere", teamMembershipId: existing.id };
        }
    }

    return withTeamSessionAccessEffectsInTx(tx, {
        teamId: input.teamId,
        accountIds: [input.accountId],
        sessionAccessImpacts: input.sessionAccessImpacts,
    }, async (sessionAccessImpacts) => {
        if (input.desired === "absent") {
            if (!existing) return { status: "unchanged", teamMembershipId: null, accountId: input.accountId };
            // Confirmed source removal ends the lifetime it owns. Group rows and
            // their contributions — including other sources' — cascade with it,
            // because a Group source cannot keep somebody in a Team it does not
            // manage. The removal preview discloses that consequence.
            await revokeTeamCredentialExternalApiKeysForMembershipInTx(tx, {
                teamId: input.teamId,
                membershipId: existing.id,
                actor: { kind: "system" },
            });
            await revokeTeamCredentialAudienceForMembershipInTx(tx, {
                teamId: input.teamId,
                teamMembershipId: existing.id,
                accountId: input.accountId,
                actor: { kind: "system" },
            });
            await tx.teamMembership.delete({ where: { id: existing.id } });
            if (input.publishChange !== false) {
                await publishTeamChangedInTx(tx, {
                    teamId: input.teamId,
                    additionalAccountIds: [input.accountId],
                });
            }
            return { status: "applied", teamMembershipId: null, accountId: input.accountId };
        }

        const desiredStatus = input.desired === "suspended"
            ? TeamMembershipStatus.suspended
            : TeamMembershipStatus.active;

        if (!existing) {
            if (desiredStatus === TeamMembershipStatus.suspended) {
                // A suspended user who has never been admitted has no access to
                // revoke; creating a suspended membership would invent a lifetime.
                return { status: "unchanged", teamMembershipId: null, accountId: input.accountId };
            }
            const admitted = await admitTeamMemberInTx(tx, {
                teamId: input.teamId,
                accountId: input.accountId,
                role: TeamRole.member,
                historyAccess: team.defaultSessionHistoryAccess,
                sessionAccessImpacts,
            });
            if (!admitted.ok) {
                return admitted.error === "team_archived"
                    ? { status: "team_archived" }
                    : { status: "management_conflict" };
            }
            if (admitted.outcome !== "added") return { status: "management_conflict" };
            if (input.source.kind === "directory_source") {
                await tx.teamProvisionedIdentity.update({
                    where: { id: identity!.id },
                    data: {
                        teamMembershipId: admitted.membership.teamMembershipId,
                        teamMembershipTeamId: input.teamId,
                    },
                });
            } else {
                await tx.teamMembershipIdentityConnectionManagement.create({
                    data: {
                        teamMembershipId: admitted.membership.teamMembershipId,
                        teamId: input.teamId,
                        teamIdentityConnectionId: input.source.teamIdentityConnectionId,
                    },
                });
            }
            if (input.publishChange !== false) {
                await publishTeamChangedInTx(tx, {
                    teamId: input.teamId,
                    additionalAccountIds: [input.accountId],
                });
            }
            return {
                status: "applied",
                teamMembershipId: admitted.membership.teamMembershipId,
                accountId: input.accountId,
            };
        }

        if (existing.status === desiredStatus) {
            // A replay changes nothing — not the lifetime, not the role, and above
            // all not the retained history horizon.
            return { status: "unchanged", teamMembershipId: existing.id, accountId: input.accountId };
        }
        await setTeamMembershipStatusInTx(tx, {
            teamId: input.teamId,
            membershipId: existing.id,
            accountId: input.accountId,
            status: desiredStatus,
            sessionAccessImpacts,
        });
        if (input.publishChange !== false) {
            await publishTeamChangedInTx(tx, {
                teamId: input.teamId,
                additionalAccountIds: [input.accountId],
            });
        }
        return { status: "applied", teamMembershipId: existing.id, accountId: input.accountId };
    });
}

/**
 * The projected directory people whose Group evidence may contribute a Group
 * row — the one eligibility rule for every directory contribution path
 * (reconciliation, sign-in materialization, mapping) and for this owner.
 *
 * An active person contributes. A suspended person contributes only while this
 * source also owns the person's Team lifetime (`teamMembershipId`): that
 * lifetime is suspended with them, so its Group row is retained dormant with
 * its horizon and returns on reactivation (child 05 §8, Lane 01 horizon
 * retention). When native administration or another owner keeps the lifetime
 * active, a deactivated person's contribution from THIS source is withdrawn —
 * otherwise their Group access stays effective after offboarding. Only this
 * binding's contribution goes; the parent membership and every other
 * contribution are untouched.
 */
export function directoryGroupContributorIdentityWhere() {
    return {
        boundAccountId: { not: null },
        OR: [
            { state: "active" as const },
            { state: "suspended" as const, teamMembershipId: { not: null } },
        ],
    };
}

/**
 * A management handoff can end a suspended identity's dormant-contribution
 * eligibility without a new directory observation. Reconcile that exact source
 * now, through the same contribution owner, instead of waiting for its next sync.
 * Active identities still contribute independently of who owns the Team lifetime.
 */
export async function withdrawIneligibleDirectoryGroupContributionsInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        teamMembershipId: string;
        accountId: string;
        directorySourceId: string;
        releasedIdentityState: "active" | "suspended" | "deleted";
        sessionAccessImpacts: TeamSessionAccessImpacts;
    }>,
): Promise<void> {
    // Only suspension eligibility depends on owning the Team lifetime. Active
    // people still contribute; partial roster evidence cannot revoke them here.
    if (input.releasedIdentityState !== "suspended") return;
    const [projectedMembers, contributions] = await Promise.all([
        tx.teamDirectoryGroupMember.findMany({
            where: {
                directorySourceId: input.directorySourceId,
                identity: { ...directoryGroupContributorIdentityWhere(), boundAccountId: input.accountId },
            },
            select: { externalGroupId: true },
        }),
        tx.teamGroupMembershipExternalContribution.findMany({
            where: {
                teamMembershipId: input.teamMembershipId,
                binding: { teamId: input.teamId, directorySourceId: input.directorySourceId },
            },
            select: { teamGroupId: true, externalGroupBindingId: true, binding: { select: { externalGroupId: true } } },
        }),
    ]);
    const eligibleGroupIds = new Set(projectedMembers.map((member) => member.externalGroupId));
    for (const contribution of contributions) {
        if (eligibleGroupIds.has(contribution.binding.externalGroupId)) continue;
        await applyTeamGroupContributionInTx(tx, {
            teamId: input.teamId,
            teamGroupId: contribution.teamGroupId,
            teamMembershipId: input.teamMembershipId,
            contribution: { kind: "external", externalGroupBindingId: contribution.externalGroupBindingId },
            desired: "absent",
            // Removal never mints a horizon; retained union members keep theirs.
            historyAccess: "from_membership",
            sessionAccessImpacts: input.sessionAccessImpacts,
        });
    }
}

export type ExternalGroupContributionResult =
    | Readonly<{ status: "ok"; outcome: TeamGroupContributionOutcome }>
    | Readonly<{ status: "binding_not_found" }>
    | Readonly<{ status: "group_archived" }>
    | Readonly<{ status: "not_team_member" }>;

/**
 * Add or remove one exact source contribution to a Group roster.
 *
 * The binding is validated against both the Team and the Group it claims to
 * target, because an id-only check would let a valid binding for Group A
 * contribute to Group B. Beyond that this is a plain set-union write: no
 * precedence, no overwrite, and no ability to remove another source's or the
 * native contribution.
 */
export async function applyExternalGroupContributionInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        groupId: string;
        accountId: string;
        externalGroupBindingId: string;
        desired: "present" | "absent";
        /**
         * Legacy prepared hint, intentionally ignored. The current Team default
         * is reread by this final transaction before the first contribution.
         */
        historyAccess: SessionHistoryAccess;
        sessionAccessImpacts?: TeamSessionAccessImpacts;
        /** `false` lets a set-oriented caller publish once for its whole batch. */
        publishChange?: boolean;
    }>,
): Promise<ExternalGroupContributionResult> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.accountId], affectedAccountIds: [input.accountId], membershipChange: { kind: "teamGroupMembership", teamId: input.teamId, teamGroupIds: [input.groupId] } });
    const binding = await tx.teamExternalGroupBinding.findUnique({
        where: { id: input.externalGroupBindingId },
        select: {
            id: true,
            teamId: true,
            teamGroupId: true,
            directorySourceId: true,
            externalGroupId: true,
            group: { select: { archivedAt: true } },
        },
    });
    if (
        !binding
        || binding.teamId !== input.teamId
        || binding.teamGroupId !== input.groupId
    ) {
        return { status: "binding_not_found" };
    }

    const membership = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: input.teamId, accountId: input.accountId } },
        select: { id: true },
    });
    // Group membership hangs on the Team-membership lifetime. A directory that
    // has not yet produced the Team membership contributes nothing rather than
    // creating an orphan the composite foreign key would reject anyway.
    if (!membership) return { status: "not_team_member" };

    // Archiving retains existing grants, and reconciliation must still be able
    // to remove one while archived. It must not create a new dormant grant that
    // would become effective merely because an administrator later restores the
    // Group. Enforce that lifecycle boundary before requiring fresh directory
    // projection evidence: an archived target is the decisive reason no new
    // contribution may be admitted.
    if (binding.group.archivedAt !== null && input.desired === "present") {
        const retainedContribution = await tx.teamGroupMembershipExternalContribution.findUnique({
            where: {
                teamGroupId_teamMembershipId_externalGroupBindingId: {
                    teamGroupId: binding.teamGroupId,
                    teamMembershipId: membership.id,
                    externalGroupBindingId: binding.id,
                },
            },
            select: { externalGroupBindingId: true },
        });
        if (!retainedContribution) return { status: "group_archived" };
    }

    if (binding.directorySourceId !== null && input.desired === "present") {
        // Structural Team membership is only the target address. For a
        // directory-owned binding, the source's exact person/Group projection
        // must still bind this Account before the adapter can materialize
        // native authorization. Whether this source also manages the Team
        // lifetime is a separate question and deliberately not asked here: a
        // natively invited person, or one a second directory admitted, still
        // has exact Group evidence from this source. This consumes Lane 03
        // evidence without making it an authorization store: the resulting
        // TeamGroupMembership remains the only fact Lane 04 reads.
        const projectedMember = await tx.teamDirectoryGroupMember.findFirst({
            where: {
                directorySourceId: binding.directorySourceId,
                externalGroupId: binding.externalGroupId,
                identity: {
                    ...directoryGroupContributorIdentityWhere(),
                    boundAccountId: input.accountId,
                },
            },
            select: { externalUserId: true },
        });
        if (!projectedMember) return { status: "binding_not_found" };
    }

    // External reconciliation does not carry horizon policy authority. Reread
    // the current Team default in the final transaction that creates the first
    // effective Group contribution, so prepared/stale source input cannot mint
    // the wrong history horizon.
    const team = await tx.team.findUnique({
        where: { id: input.teamId },
        select: { defaultSessionHistoryAccess: true },
    });
    if (!team) return { status: "binding_not_found" };

    const applied = await applyTeamGroupContributionInTx(tx, {
        teamId: input.teamId,
        teamGroupId: binding.teamGroupId,
        teamMembershipId: membership.id,
        contribution: { kind: "external", externalGroupBindingId: binding.id },
        desired: input.desired,
        historyAccess: team.defaultSessionHistoryAccess,
        sessionAccessImpacts: input.sessionAccessImpacts,
    });
    if (applied.outcome !== "unchanged" && input.publishChange !== false) {
        await publishTeamChangedInTx(tx, { teamId: input.teamId });
    }
    return { status: "ok", outcome: applied.outcome };
}

export type ExternalManagedGroupResult =
    | Readonly<{ status: "applied" | "unchanged"; teamGroupId: string }>
    | Readonly<{ status: "binding_not_found" }>
    | Readonly<{ status: "not_metadata_owner" }>;

/**
 * The metadata lifecycle of a Group a directory created.
 *
 * Only a `directory_created` binding may drive this, and at most one such
 * binding may target a Group, so there is one metadata owner and no precedence
 * question. `retired` archives the Group: rows and horizons are retained, and
 * restoring it re-enables exactly the grants that are still valid. Nothing here
 * deletes a roster.
 *
 * A directory rename uses the label's stored privacy arm rather than a current
 * or synthetic author. It reseals the transient source name to today's Team
 * audience and never retains a plaintext comparison or name-derived key.
 */
export async function applyExternalManagedGroupInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        externalGroupBindingId: string;
        desired: "active" | "retired";
        sourceDisplayName?: string;
        sessionAccessImpacts?: TeamSessionAccessImpacts;
        /** `false` lets a set-oriented caller publish once for its whole batch. */
        publishChange?: boolean;
    }>,
): Promise<ExternalManagedGroupResult> {
    const binding = await tx.teamExternalGroupBinding.findUnique({
        where: { id: input.externalGroupBindingId },
        select: { id: true, teamId: true, teamGroupId: true, bindingMode: true },
    });
    if (!binding || binding.teamId !== input.teamId) return { status: "binding_not_found" };
    if (binding.bindingMode !== TeamExternalGroupBindingMode.directory_created) {
        // A native-target Group keeps native metadata authority even while this
        // source contributes members to it.
        return { status: "not_metadata_owner" };
    }

    const group = await tx.teamGroup.findUnique({
        where: { id: binding.teamGroupId },
        select: { id: true, name: true, archivedAt: true },
    });
    if (!group) return { status: "binding_not_found" };

    const shouldArchive = input.desired === "retired";
    const archivedAt = shouldArchive ? (group.archivedAt ?? new Date()) : null;
    const archiveChanged = (group.archivedAt !== null) !== shouldArchive;

    let renamed = false;
    let name = group.name;
    if (input.sourceDisplayName !== undefined) {
        const candidate = validateTeamGroupNameV1(input.sourceDisplayName);
        if (candidate.status === "ok") {
            const sealed = await prepareTeamGroupNameForAutomatedWriteInTx({
                tx,
                teamId: input.teamId,
                groupId: group.id,
                currentSerialized: group.name,
                nextValue: candidate.name,
            });
            if (sealed.kind === "ready") {
                name = sealed.serialized;
                renamed = true;
            }
        }
    }

    if (!archiveChanged && !renamed) return { status: "unchanged", teamGroupId: group.id };

    return withTeamSessionAccessEffectsInTx(tx, {
        teamId: input.teamId, teamGroupId: group.id, sessionAccessImpacts: input.sessionAccessImpacts,
    }, async () => {
        await tx.teamGroup.update({
            where: { id: group.id },
            data: { archivedAt, name },
        });
        if (input.publishChange !== false) {
            await publishTeamChangedInTx(tx, { teamId: input.teamId });
        }
        return { status: "applied", teamGroupId: group.id };
    });
}

export type ExternalSourceRevocationResult = Readonly<{
    /** Effective Group memberships that lost this source's contribution. */
    contributionsRemoved: number;
    /** Membership lifetimes this source owned and therefore ended. */
    membershipsRemoved: number;
    affectedAccountIds: readonly string[];
}>;

export type ExternalGroupBindingRemovalResult =
    | Readonly<{ status: "already_absent"; contributionsRemoved: 0; affectedAccountIds: readonly [] }>
    | Readonly<{ status: "removed"; contributionsRemoved: number; affectedAccountIds: readonly string[] }>;

/** Remove one binding through the canonical contribution-union owner. */
export async function removeExternalGroupBindingInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; bindingId: string; publishChange?: boolean; sessionAccessImpacts?: TeamSessionAccessImpacts }>,
): Promise<ExternalGroupBindingRemovalResult> {
    const binding = await tx.teamExternalGroupBinding.findFirst({
        where: { id: input.bindingId, teamId: input.teamId },
        select: {
            id: true,
            contributions: {
                select: {
                    teamGroupId: true,
                    teamMembershipId: true,
                    membership: { select: { teamMembership: { select: { accountId: true } } } },
                },
            },
        },
    });
    if (!binding) {
        return { status: "already_absent", contributionsRemoved: 0, affectedAccountIds: [] };
    }

    const affectedAccountIds = new Set<string>();
    const admissionAccountIds = binding.contributions.map(row => row.membership.teamMembership.accountId);
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: admissionAccountIds,
        affectedAccountIds: admissionAccountIds, membershipChange: { kind: "teamGroupMembership", teamId: input.teamId,
            teamGroupIds: [...new Set(binding.contributions.map(row => row.teamGroupId))] } });
    for (const contribution of binding.contributions) {
        await applyTeamGroupContributionInTx(tx, {
            teamId: input.teamId,
            teamGroupId: contribution.teamGroupId,
            teamMembershipId: contribution.teamMembershipId,
            contribution: { kind: "external", externalGroupBindingId: binding.id },
            desired: "absent",
            historyAccess: "from_membership",
            sessionAccessImpacts: input.sessionAccessImpacts,
        });
        affectedAccountIds.add(contribution.membership.teamMembership.accountId);
    }
    await tx.teamExternalGroupBinding.delete({ where: { id: binding.id } });
    if (input.publishChange !== false) {
        await publishTeamChangedInTx(tx, {
            teamId: input.teamId,
            additionalAccountIds: [...affectedAccountIds],
        });
    }
    return {
        status: "removed",
        contributionsRemoved: binding.contributions.length,
        affectedAccountIds: [...affectedAccountIds],
    };
}

export async function readExternalSourceAccountIdsInTx(
    tx: Tx,
    input: Readonly<{ owner: ExternalFactOwner }>,
): Promise<readonly string[]> {
    const ownerWhere = input.owner.kind === "directory_source"
        ? { directorySourceId: input.owner.directorySourceId }
        : { teamIdentityConnectionId: input.owner.teamIdentityConnectionId };
    const bindings = await tx.teamExternalGroupBinding.findMany({
        where: ownerWhere,
        select: { contributions: { select: { membership: { select: { teamMembership: { select: { accountId: true } } } } } } },
    });
    const identities = input.owner.kind === "directory_source" ? await tx.teamProvisionedIdentity.findMany({
        where: { directorySourceId: input.owner.directorySourceId, boundAccountId: { not: null } },
        select: { boundAccountId: true },
    }) : [];
    const memberships = input.owner.kind === "identity_connection" ? await tx.teamMembershipIdentityConnectionManagement.findMany({
        where: { teamIdentityConnectionId: input.owner.teamIdentityConnectionId },
        select: { membership: { select: { accountId: true } } },
    }) : [];
    return [
        ...identities.flatMap(identity => identity.boundAccountId ?? []),
        ...memberships.map(row => row.membership.accountId),
        ...bindings.flatMap(binding => binding.contributions.map(row => row.membership.teamMembership.accountId)),
    ];
}

/** Admit retained lifecycle targets with the actor before source/resource writes. */
export async function acquireExternalSourceAccountAdmissionInTx(
    tx: Tx,
    input: Readonly<{ owner: ExternalFactOwner; actorAccountIds?: readonly string[] }>,
): Promise<Readonly<{ teamId: string; recheck: () => Promise<void> }> | null> {
    const affectedAccountIds = await readExternalSourceAccountIdsInTx(tx, input);
    const accountIds = [...(input.actorAccountIds ?? []), ...affectedAccountIds];
    const source = input.owner.kind === "directory_source"
        ? await tx.teamDirectorySource.findUnique({ where: { id: input.owner.directorySourceId }, select: { teamId: true } })
        : await tx.teamIdentityConnection.findUnique({ where: { id: input.owner.teamIdentityConnectionId }, select: { teamId: true } });
    let admission: Readonly<{ teamId: string; recheck: () => Promise<void> }> | null = null;
    if (source?.teamId) {
        // Directory administration subsequently invokes the canonical identity
        // authorizer, whose admission covers every Team-membership effect.
        // Enter that same complete scope before an outer Team guard is taken.
        const recheck = await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: source.teamId, accountIds,
            membershipChange: { kind: "teamMembership", teamId: source.teamId } });
        admission = { teamId: source.teamId, recheck };
    } else {
        await acquireAccountChangePublicationLocksInTx(tx, accountIds, { includeSingleAccount: true });
    }
    beforeAccountChangePublication(tx, accountIds, async () => {
        assertAccountChangePublicationAudienceInTx(tx, await readExternalSourceAccountIdsInTx(tx, input));
    });
    return admission;
}

/**
 * Remove every native fact one external source owns atomically, retaining Group
 * metadata, native contributions, and their existing membership horizons.
 */
export async function revokeExternalSourceFactsInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; owner: ExternalFactOwner }>,
): Promise<ExternalSourceRevocationResult> {
    await acquireExternalSourceAccountAdmissionInTx(tx, input);
    const ownerWhere = input.owner.kind === "directory_source"
        ? { directorySourceId: input.owner.directorySourceId }
        : { teamIdentityConnectionId: input.owner.teamIdentityConnectionId };

    const bindings = await tx.teamExternalGroupBinding.findMany({
        where: { teamId: input.teamId, ...ownerWhere },
        select: {
            id: true,
            contributions: { select: { membership: { select: { teamMembership: { select: { accountId: true } } } } } },
        },
    });

    const identities = input.owner.kind === "directory_source" ? await tx.teamProvisionedIdentity.findMany({
        where: { directorySourceId: input.owner.directorySourceId, teamMembershipId: { not: null } },
        select: {
            boundAccountId: true,
            teamMembership: { select: { id: true, teamId: true, accountId: true } },
        },
    }) : [];
    for (const identity of identities) {
        if (identity.teamMembership && identity.boundAccountId !== identity.teamMembership.accountId) {
            throw new Error("External membership ownership binding is inconsistent");
        }
    }
    const connectionManagedMemberships = input.owner.kind === "identity_connection"
        ? await tx.teamMembershipIdentityConnectionManagement.findMany({
            where: {
                teamId: input.teamId,
                teamIdentityConnectionId: input.owner.teamIdentityConnectionId,
            },
            select: {
                membership: { select: { id: true, teamId: true, accountId: true } },
            },
        })
        : [];
    const memberships = [
        ...identities.flatMap(identity => identity.teamMembership?.teamId === input.teamId
            ? [identity.teamMembership]
            : []),
        ...connectionManagedMemberships.map(({ membership }) => membership),
    ];
    const accountIds = [
        ...memberships.map(member => member.accountId),
        ...bindings.flatMap(binding => binding.contributions.map(contribution => contribution.membership.teamMembership.accountId)),
    ];
    return withTeamSessionAccessEffectsInTx(tx, { teamId: input.teamId, accountIds }, async (sessionAccessImpacts) => {
        const affected = new Set<string>();
        let contributionsRemoved = 0;

        for (const binding of bindings) {
            const removed = await removeExternalGroupBindingInTx(tx, {
                teamId: input.teamId,
                bindingId: binding.id,
                publishChange: false,
                sessionAccessImpacts,
            });
            if (removed.status === "already_absent") continue;
            contributionsRemoved += removed.contributionsRemoved;
            for (const accountId of removed.affectedAccountIds) affected.add(accountId);
        }

        let membershipsRemoved = 0;
        for (const membership of memberships) {
            await revokeTeamCredentialExternalApiKeysForMembershipInTx(tx, {
                teamId: input.teamId,
                membershipId: membership.id,
                actor: { kind: "system" },
            });
            await revokeTeamCredentialAudienceForMembershipInTx(tx, {
                teamId: input.teamId,
                teamMembershipId: membership.id,
                accountId: membership.accountId,
                actor: { kind: "system" },
            });
            await tx.teamMembership.delete({ where: { id: membership.id } });
            membershipsRemoved += 1;
            affected.add(membership.accountId);
        }

        if (contributionsRemoved > 0 || membershipsRemoved > 0 || bindings.length > 0) {
            await publishTeamChangedInTx(tx, {
                teamId: input.teamId,
                additionalAccountIds: [...affected],
            });
        }

        return {
            contributionsRemoved,
            membershipsRemoved,
            affectedAccountIds: [...affected],
        };
    });
}
