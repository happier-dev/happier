import { withTeamSessionAccessEffectsInTx } from "../memberships/sessionAccessEffects";
import { createHash, randomUUID } from "node:crypto";

import type {
    TeamErrorCodeV1,
    TeamGroupMemberMutationResultV1,
    TeamGroupMemberV1,
    TeamGroupMembersPageV1,
    TeamGroupV1,
    TeamGroupsPageV1,
} from "@happier-dev/protocol/teams";
import {
    TEAM_GROUPS_PAGE_LIMIT_DEFAULT_V1,
    TEAM_GROUP_MEMBERS_PAGE_LIMIT_DEFAULT_V1,
    decodeTeamGroupMembersCursorV1,
    decodeTeamGroupsCursorV1,
    encodeTeamGroupMembersCursorV1,
    encodeTeamGroupsCursorV1,
    teamGroupMembersQueryKeyV1,
    teamGroupNameKeyV1,
    teamGroupsQueryKeyV1,
    teamMemberGroupsQueryKeyV1,
    validateTeamGroupDescriptionV1,
    validateTeamGroupNameV1,
} from "@happier-dev/protocol/teams";
import { resolveGrantableTeamsForActorInTx } from "../queries";

import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { acquireTeamMutationAccountAdmissionInTx } from "../memberships/sessionAccessEffects";
import type { SessionHistoryAccess } from "@/storage/enums.generated";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { defaultRepeatKeyExpiresAt, fetchRepeatKey, saveRepeatKey } from "@/storage/queue/repeatKey";
import {
    acquireTeamMutationLockInTx,
    qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextInTx,
    type TeamActorContext,
    type TeamOperationAuthenticationContext,
} from "../actorContext";
import { publishTeamChangedInTx } from "../teamChanges";
import { applyTeamGroupContributionInTx } from "./groupContributions";
import { EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE } from "./effectiveGroupMembership";
import {
    projectTeamGroupMemberV1,
    projectTeamGroupV1,
    readTeamGroupBindingsInTx,
    readTeamGroupBindingsForPageInTx,
    TEAM_GROUP_MEMBERSHIP_ROW_SELECT,
    TEAM_GROUP_ROW_SELECT,
    resolveTeamGroupCapabilitiesV1,
    projectTeamGroupManagementV1,
    type TeamGroupRow,
} from "./project";

/**
 * The authorized flat-Group operations.
 *
 * A Group is a named targeting set inside exactly one Team, and this module is
 * its whole lifecycle: name, description, archive state, roster, and the native
 * half of the contribution union. There is no Group role,
 * no nesting, and no deny precedence, so every decision here is either "may this
 * actor manage Groups in this Team" or "does this Group currently exist".
 */

export type TeamGroupServiceError = Extract<TeamErrorCodeV1,
    | "team_not_found"
    | "team_forbidden"
    | "team_archived"
    | "team_authentication_required"
    | "team_authentication_unavailable"
    | "team_conflict"
    | "invalid_team_input"
    | "invalid_team_cursor"
    | "membership_not_found"
    | "group_not_found"
    | "group_archived"
    | "group_name_taken"
    | "managed_by_directory"
    | "not_team_member"
>;

export type TeamGroupServiceResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: TeamGroupServiceError }>;

function denied(error: TeamGroupServiceError): Readonly<{ ok: false; error: TeamGroupServiceError }> {
    return { ok: false, error };
}

async function resolveTeamViewerContextInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string }>,
): Promise<TeamGroupServiceResult<TeamActorContext>> {
    const context = await resolveTeamActorContextInTx(tx, input);
    // The same read admission the roster uses: membership, or Home recovery of
    // an ownerless Team, which reaches Groups through the same overview.
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
): Promise<TeamGroupServiceResult<TeamActorContext>> {
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
 * A Group reached through a Team that does not own it reads as absent: a Group
 * id must not become a probe for another Team's structure.
 */
async function readGroupRowInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; groupId: string }>,
): Promise<TeamGroupRow | null> {
    const row = await tx.teamGroup.findUnique({
        where: { id: input.groupId },
        select: TEAM_GROUP_ROW_SELECT,
    });
    return row && row.teamId === input.teamId ? row : null;
}

/** Managed defaults use Group management, independently of directory-owned metadata. */
export async function authorizeTeamGroupDefaultsInTx(
    tx: Tx,
    input: Readonly<{ context: TeamActorContext; teamGroupId: string }>,
): Promise<"group_not_found" | "team_archived" | "team_forbidden" | "group_archived" | null> {
    const row = await readGroupRowInTx(tx, { teamId: input.context.team.id, groupId: input.teamGroupId });
    if (!row) return "group_not_found";
    if (input.context.team.archivedAt !== null) return "team_archived";
    if (!input.context.teamCapabilities.manageGroups) return "team_forbidden";
    if (row.archivedAt !== null) return "group_archived";
    const bindings = await readTeamGroupBindingsInTx(tx, { teamGroupId: row.id });
    const capabilities = resolveTeamGroupCapabilitiesV1({
        manageGroups: input.context.teamCapabilities.manageGroups,
        teamArchivedAt: input.context.team.archivedAt,
        group: row,
        management: projectTeamGroupManagementV1(bindings),
    });
    return capabilities.manageNativeMembers ? null : "team_forbidden";
}

/** Commit-time Group grantability through the canonical member Team directory. */
export async function resolveGrantableTeamGroupForActorInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; teamId: string; groupId: string }>,
): Promise<Readonly<{ teamId: string; groupId: string }> | null> {
    const groups = await resolveGrantableTeamGroupsForActorInTx(tx, {
        actorAccountId: input.actorAccountId, groups: [input],
    });
    const group = groups.get(input.groupId);
    return group?.teamId === input.teamId ? { teamId: group.teamId, groupId: group.groupId } : null;
}

/** Selected Group identities and labels, admitted by the same Team membership owner. */
export async function resolveGrantableTeamGroupsForActorInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        groups: readonly Readonly<{ teamId: string; groupId: string }>[];
        /** Only the canonical Team reader's result for this actor in this exact operation/transaction. */
        grantableTeamIds?: ReadonlySet<string>;
    }>,
): Promise<ReadonlyMap<string, Readonly<{ teamId: string; groupId: string; name: string }>>> {
    if (input.groups.length === 0) return new Map();
    const grantableTeamIds = input.grantableTeamIds ?? await resolveGrantableTeamsForActorInTx(tx, {
        actorAccountId: input.actorAccountId, teamIds: input.groups.map(group => group.teamId),
    });
    const groupIds = [...new Set(input.groups.filter(group => grantableTeamIds.has(group.teamId)).map(group => group.groupId))];
    if (groupIds.length === 0) return new Map();
    const groups = (await Promise.all(portableQueryChunks({ values: groupIds, bindingsPerValue: 1, fixedBindings: 1 }).map(ids => tx.teamGroup.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, teamId: true, name: true, archivedAt: true },
    })))).flat();
    return new Map(groups.filter(group => group.archivedAt === null && grantableTeamIds.has(group.teamId))
        .map(group => [group.id, { teamId: group.teamId, groupId: group.id, name: group.name }]));
}

async function projectGroupInTx(
    tx: Tx,
    input: Readonly<{ context: TeamActorContext; row: TeamGroupRow }>,
): Promise<TeamGroupV1> {
    const [memberCount, bindings] = await Promise.all([
        tx.teamGroupMembership.count({
            where: {
                teamGroupId: input.row.id,
                ...EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE,
            },
        }),
        readTeamGroupBindingsInTx(tx, { teamGroupId: input.row.id }),
    ]);
    return projectTeamGroupV1({
        row: input.row,
        memberCount,
        manageGroups: input.context.teamCapabilities.manageGroups,
        teamArchivedAt: input.context.team.archivedAt,
        bindings,
    });
}

async function projectGroupPageInTx(
    tx: Tx,
    input: Readonly<{ context: TeamActorContext; rows: readonly TeamGroupRow[] }>,
): Promise<TeamGroupV1[]> {
    const groupIds = input.rows.map((row) => row.id);
    if (groupIds.length === 0) return [];
    const [counts, bindingsByGroup] = await Promise.all([
        tx.teamGroupMembership.groupBy({
            by: ["teamGroupId"],
            where: {
                teamGroupId: { in: groupIds },
                ...EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE,
            },
            _count: { _all: true },
        }),
        readTeamGroupBindingsForPageInTx(tx, { teamGroupIds: groupIds }),
    ]);
    const countByGroup = new Map(counts.map((count) => [count.teamGroupId, count._count._all]));
    return input.rows.map((row) => projectTeamGroupV1({
        row,
        memberCount: countByGroup.get(row.id) ?? 0,
        manageGroups: input.context.teamCapabilities.manageGroups,
        teamArchivedAt: input.context.team.archivedAt,
        bindings: bindingsByGroup.get(row.id) ?? [],
    }));
}

export async function listTeamGroupsForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        archived: "active" | "archived";
        cursor?: string | null;
        limit?: number;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamGroupServiceResult<TeamGroupsPageV1>> {
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const qualified = await qualifyTeamViewerInTx(tx, {
        context: authorized.value,
        authentication: input.authentication,
        allowHomeRecovery: true,
    });
    if (!qualified.ok) return qualified;
    const context = qualified.value;

    const queryKey = teamGroupsQueryKeyV1({
        v: 1,
        teamId: input.teamId,
        archived: input.archived,
    });
    let after: Readonly<{ nameKey: string; id: string }> | null = null;
    if (input.cursor) {
        const decoded = decodeTeamGroupsCursorV1(input.cursor, queryKey);
        if (decoded.status !== "ok") return denied("invalid_team_cursor");
        after = decoded.cursor;
    }

    const limit = input.limit ?? TEAM_GROUPS_PAGE_LIMIT_DEFAULT_V1;
    const rows = await tx.teamGroup.findMany({
        where: {
            teamId: input.teamId,
            archivedAt: input.archived === "archived" ? { not: null } : null,
            ...(after
                ? {
                    OR: [
                        { nameKey: { gt: after.nameKey } },
                        { nameKey: after.nameKey, id: { gt: after.id } },
                    ],
                }
                : {}),
        },
        orderBy: [{ nameKey: "asc" }, { id: "asc" }],
        take: limit + 1,
        select: TEAM_GROUP_ROW_SELECT,
    });

    const page = rows.slice(0, limit);
    const items = await projectGroupPageInTx(tx, { context, rows: page });
    const last = rows.length > limit ? page[page.length - 1] : undefined;

    return {
        ok: true,
        value: {
            items,
            nextCursor: last
                ? encodeTeamGroupsCursorV1({ queryKey, nameKey: last.nameKey, id: last.id })
                : null,
        },
    };
}

/**
 * Page the effective Groups attached to one immutable membership lifetime.
 *
 * This deliberately projects through the same Group owner as the Team-wide
 * list. Member detail therefore gets identical metadata, source navigation and
 * capabilities instead of growing a second, thinner Group representation.
 */
export async function listTeamMemberGroupsForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        membershipId: string;
        cursor?: string | null;
        limit?: number;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamGroupServiceResult<TeamGroupsPageV1>> {
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const qualified = await qualifyTeamViewerInTx(tx, {
        context: authorized.value,
        authentication: input.authentication,
        allowHomeRecovery: true,
    });
    if (!qualified.ok) return qualified;
    const context = qualified.value;

    const membership = await tx.teamMembership.findUnique({
        where: { id: input.membershipId },
        select: { teamId: true },
    });
    if (!membership || membership.teamId !== input.teamId) return denied("membership_not_found");

    const queryKey = teamMemberGroupsQueryKeyV1({
        teamId: input.teamId,
        membershipId: input.membershipId,
    });
    let after: Readonly<{ nameKey: string; id: string }> | null = null;
    if (input.cursor) {
        const decoded = decodeTeamGroupsCursorV1(input.cursor, queryKey);
        if (decoded.status !== "ok") return denied("invalid_team_cursor");
        after = decoded.cursor;
    }

    const limit = input.limit ?? TEAM_GROUPS_PAGE_LIMIT_DEFAULT_V1;
    const rows = await tx.teamGroup.findMany({
        where: {
            teamId: input.teamId,
            memberships: { some: { teamMembershipId: input.membershipId } },
            ...(after
                ? {
                    OR: [
                        { nameKey: { gt: after.nameKey } },
                        { nameKey: after.nameKey, id: { gt: after.id } },
                    ],
                }
                : {}),
        },
        orderBy: [{ nameKey: "asc" }, { id: "asc" }],
        take: limit + 1,
        select: TEAM_GROUP_ROW_SELECT,
    });

    const page = rows.slice(0, limit);
    const items = await projectGroupPageInTx(tx, { context, rows: page });
    const last = rows.length > limit ? page[page.length - 1] : undefined;
    return {
        ok: true,
        value: {
            items,
            nextCursor: last
                ? encodeTeamGroupsCursorV1({ queryKey, nameKey: last.nameKey, id: last.id })
                : null,
        },
    };
}

export async function getTeamGroupForActorInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string; groupId: string; authentication?: TeamOperationAuthenticationContext }>,
): Promise<TeamGroupServiceResult<TeamGroupV1>> {
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const qualified = await qualifyTeamViewerInTx(tx, {
        context: authorized.value,
        authentication: input.authentication,
        allowHomeRecovery: true,
    });
    if (!qualified.ok) return qualified;

    const row = await readGroupRowInTx(tx, input);
    if (!row) return denied("group_not_found");
    return { ok: true, value: await projectGroupInTx(tx, { context: qualified.value, row }) };
}

function groupCreateRequestKey(actorAccountId: string, teamId: string, requestKey: string): string {
    return `teams.groups.create:${actorAccountId}:${teamId}:${requestKey}`;
}

function groupCreatePayloadDigest(input: Readonly<{ name: string; description: string | null }>): string {
    return createHash("sha256")
        .update(JSON.stringify([input.name, input.description]))
        .digest("base64url");
}

/**
 * Create one flat Group.
 *
 * The retry identity is the caller's own request key bound to the exact payload,
 * reusing the existing repeat-key facility scoped to this operation. Without it
 * a lost response would either create a second Group or — worse — come back as
 * `group_name_taken` against the Group the caller had already created.
 */
export async function createTeamGroupForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        name: string;
        description?: string | null;
        requestKey: string;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamGroupServiceResult<TeamGroupV1>> {
    const recheckAdmission = await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.actorAccountId] });
    await acquireTeamMutationLockInTx(tx, input.teamId);
    await recheckAdmission();
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const context = authorized.value;
    if (context.team.archivedAt !== null) return denied("team_archived");
    if (!context.teamCapabilities.manageGroups) return denied("team_forbidden");
    const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
    if (!qualified.ok) return qualified;

    const name = validateTeamGroupNameV1(input.name);
    if (name.status !== "ok") return denied("invalid_team_input");
    const description = validateTeamGroupDescriptionV1(input.description);
    if (description.status !== "ok") return denied("invalid_team_input");

    const dedupeKey = groupCreateRequestKey(context.actorAccountId, input.teamId, input.requestKey);
    const digest = groupCreatePayloadDigest({
        name: name.name,
        description: description.description,
    });
    const now = await readTransactionDatabaseTime(tx);
    const recorded = await fetchRepeatKey(tx, dedupeKey, now);
    if (recorded !== null) {
        const [recordedDigest, recordedGroupId] = recorded.split(":");
        if (recordedDigest !== digest || !recordedGroupId) return denied("team_conflict");
        const replayed = await readGroupRowInTx(tx, { teamId: input.teamId, groupId: recordedGroupId });
        if (!replayed) return denied("team_conflict");
        return { ok: true, value: await projectGroupInTx(tx, { context, row: replayed }) };
    }

    const nameKey = teamGroupNameKeyV1(name.name);
    const proposedId = randomUUID();
    const created = await tx.teamGroup.upsert({
        where: { teamId_nameKey: { teamId: input.teamId, nameKey } },
        create: {
            id: proposedId,
            teamId: input.teamId,
            name: name.name,
            nameKey,
            ...(description.description === null ? {} : { description: description.description }),
        },
        update: {},
        select: TEAM_GROUP_ROW_SELECT,
    });
    // The in-Team name key is unique, and an archived Group still holds its
    // name. The proposed id tells us whether this request inserted the row or
    // atomically observed somebody else's without relying on a caught P2002.
    if (created.id !== proposedId) return denied("group_name_taken");

    await saveRepeatKey(tx, dedupeKey, `${digest}:${created.id}`, defaultRepeatKeyExpiresAt(now));
    await publishTeamChangedInTx(tx, { teamId: input.teamId });
    return { ok: true, value: await projectGroupInTx(tx, { context, row: created }) };
}

/**
 * Whether this actor may change the Group's metadata lifecycle right now, and
 * the precise reason when they may not. Roster editing is a different question
 * with a different answer, which is why the two never share a check.
 */
async function authorizeGroupMetadataInTx(
    tx: Tx,
    input: Readonly<{ context: TeamActorContext; row: TeamGroupRow; operation: "update" | "archive" | "restore" }>,
): Promise<TeamGroupServiceError | null> {
    if (input.context.team.archivedAt !== null) return "team_archived";
    if (!input.context.teamCapabilities.manageGroups) return "team_forbidden";
    const bindings = await readTeamGroupBindingsInTx(tx, { teamGroupId: input.row.id });
    const management = projectTeamGroupManagementV1(bindings);
    const capabilities = resolveTeamGroupCapabilitiesV1({
        manageGroups: true,
        teamArchivedAt: input.context.team.archivedAt,
        group: input.row,
        management,
    });
    if (input.operation === "update" && capabilities.updateMetadata) return null;
    if (input.operation === "archive" && capabilities.archive) return null;
    if (input.operation === "restore" && capabilities.restore) return null;
    // A directory created this Group and owns its metadata lifecycle; archive
    // and retirement happen at that source, which the UI links to.
    if (management.kind === "directory_created") return "managed_by_directory";
    // An exact retry is allowed only after the same canonical authority and
    // management-source checks as a state-changing request. Keeping the
    // same-state decision here prevents the lifecycle caller from growing a
    // second, subtly different authorization/error-order path.
    if (input.operation === "archive" && input.row.archivedAt !== null) return null;
    if (input.operation === "restore" && input.row.archivedAt === null) return null;
    return input.row.archivedAt !== null ? "group_archived" : "team_forbidden";
}

export async function updateTeamGroupForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        groupId: string;
        name?: string;
        description?: string | null;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamGroupServiceResult<TeamGroupV1>> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.actorAccountId] });
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const context = authorized.value;

    const row = await readGroupRowInTx(tx, input);
    if (!row) return denied("group_not_found");
    const rejection = await authorizeGroupMetadataInTx(tx, { context, row, operation: "update" });
    if (rejection) return denied(rejection);
    const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
    if (!qualified.ok) return qualified;

    const data: { name?: string; nameKey?: string; description?: string | null } = {};
    if (input.name !== undefined) {
        const name = validateTeamGroupNameV1(input.name);
        if (name.status !== "ok") return denied("invalid_team_input");
        data.name = name.name;
        // Renaming never changes identity or resource grants; only the display
        // name and the in-Team uniqueness key move.
        data.nameKey = teamGroupNameKeyV1(name.name);
        const collision = await tx.teamGroup.findFirst({
            where: { teamId: input.teamId, nameKey: data.nameKey, id: { not: row.id } },
            select: { id: true },
        });
        if (collision) return denied("group_name_taken");
    }
    if (input.description !== undefined) {
        const description = validateTeamGroupDescriptionV1(input.description);
        if (description.status !== "ok") return denied("invalid_team_input");
        data.description = description.description;
    }

    // A concurrent same-name rename is allowed to abort the transaction rather
    // than catching P2002 and attempting to commit an already-aborted PostgreSQL
    // transaction. The normal collision path above remains a typed refusal.
    const updated = await tx.teamGroup.update({
        where: { id: row.id },
        data,
        select: TEAM_GROUP_ROW_SELECT,
    });

    await publishTeamChangedInTx(tx, { teamId: input.teamId });
    return { ok: true, value: await projectGroupInTx(tx, { context, row: updated }) };
}

async function setTeamGroupArchivedInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        groupId: string;
        operation: "archive" | "restore";
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamGroupServiceResult<TeamGroupV1>> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.actorAccountId], membershipChange: { kind: "teamGroupMembership", teamId: input.teamId, teamGroupIds: [input.groupId] } });
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const context = authorized.value;

    const row = await readGroupRowInTx(tx, input);
    if (!row) return denied("group_not_found");

    const rejection = await authorizeGroupMetadataInTx(tx, { context, row, operation: input.operation });
    if (rejection) return denied(rejection);
    const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
    if (!qualified.ok) return qualified;

    const alreadyInState = input.operation === "archive"
        ? row.archivedAt !== null
        : row.archivedAt === null;
    if (alreadyInState) {
        return { ok: true, value: await projectGroupInTx(tx, { context, row }) };
    }

    // Archive retains every membership row and horizon. Restoration re-enables
    // exactly the retained grants that are still valid — nothing is rebuilt.
    const archivedAt = input.operation === "archive" ? await readTransactionDatabaseTime(tx) : null;
    return withTeamSessionAccessEffectsInTx(tx, { teamId: input.teamId, teamGroupId: row.id }, async () => {
        const updated = await tx.teamGroup.update({
            where: { id: row.id },
            data: { archivedAt },
            select: TEAM_GROUP_ROW_SELECT,
        });
        await publishTeamChangedInTx(tx, { teamId: input.teamId });
        return { ok: true, value: await projectGroupInTx(tx, { context, row: updated }) };
    });
}

export function archiveTeamGroupForActorInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string; groupId: string; authentication?: TeamOperationAuthenticationContext }>,
): Promise<TeamGroupServiceResult<TeamGroupV1>> {
    return setTeamGroupArchivedInTx(tx, { ...input, operation: "archive" });
}

export function restoreTeamGroupForActorInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string; groupId: string; authentication?: TeamOperationAuthenticationContext }>,
): Promise<TeamGroupServiceResult<TeamGroupV1>> {
    return setTeamGroupArchivedInTx(tx, { ...input, operation: "restore" });
}

export async function listTeamGroupMembersForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        groupId: string;
        cursor?: string | null;
        limit?: number;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamGroupServiceResult<TeamGroupMembersPageV1>> {
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const qualified = await qualifyTeamViewerInTx(tx, {
        context: authorized.value,
        authentication: input.authentication,
        allowHomeRecovery: true,
    });
    if (!qualified.ok) return qualified;

    const row = await readGroupRowInTx(tx, input);
    if (!row) return denied("group_not_found");

    const queryKey = teamGroupMembersQueryKeyV1({ teamId: input.teamId, groupId: input.groupId });
    let after: Readonly<{ createdAt: number; teamMembershipId: string }> | null = null;
    if (input.cursor) {
        const decoded = decodeTeamGroupMembersCursorV1(input.cursor, queryKey);
        if (decoded.status !== "ok") return denied("invalid_team_cursor");
        after = decoded.cursor;
    }

    const limit = input.limit ?? TEAM_GROUP_MEMBERS_PAGE_LIMIT_DEFAULT_V1;
    // The page is over effective rows, so a member contributed by native plus
    // two directories appears exactly once — the count and the page agree.
    const rows = await tx.teamGroupMembership.findMany({
        where: {
            teamGroupId: row.id,
            ...EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE,
            ...(after
                ? {
                    OR: [
                        { createdAt: { gt: new Date(after.createdAt) } },
                        {
                            createdAt: new Date(after.createdAt),
                            teamMembershipId: { gt: after.teamMembershipId },
                        },
                    ],
                }
                : {}),
        },
        orderBy: [{ createdAt: "asc" }, { teamMembershipId: "asc" }],
        take: limit + 1,
        select: TEAM_GROUP_MEMBERSHIP_ROW_SELECT,
    });

    const page = rows.slice(0, limit);
    const bindings = await readTeamGroupBindingsInTx(tx, { teamGroupId: row.id });
    const last = rows.length > limit ? page[page.length - 1] : undefined;

    return {
        ok: true,
        value: {
            items: page.map((member) => projectTeamGroupMemberV1({ row: member, bindings })),
            nextCursor: last
                ? encodeTeamGroupMembersCursorV1({
                    queryKey,
                    createdAt: last.createdAt.getTime(),
                    teamMembershipId: last.teamMembershipId,
                })
                : null,
        },
    };
}

/**
 * Whether the actor may edit this Group's native roster, and why not otherwise.
 * A directory-created Group is still natively editable here; only its metadata
 * lifecycle belongs to the source.
 */
function authorizeGroupRosterInTx(input: Readonly<{
    context: TeamActorContext;
    row: TeamGroupRow;
}>): TeamGroupServiceError | null {
    if (input.context.team.archivedAt !== null) return "team_archived";
    if (!input.context.teamCapabilities.manageGroups) return "team_forbidden";
    if (input.row.archivedAt !== null) return "group_archived";
    return null;
}

async function projectGroupMemberInTx(
    tx: Tx,
    input: Readonly<{ teamGroupId: string; teamMembershipId: string }>,
): Promise<TeamGroupMemberV1 | null> {
    const row = await tx.teamGroupMembership.findUnique({
        where: {
            teamGroupId_teamMembershipId: {
                teamGroupId: input.teamGroupId,
                teamMembershipId: input.teamMembershipId,
            },
        },
        select: TEAM_GROUP_MEMBERSHIP_ROW_SELECT,
    });
    if (!row) return null;
    const bindings = await readTeamGroupBindingsInTx(tx, { teamGroupId: input.teamGroupId });
    return projectTeamGroupMemberV1({ row, bindings });
}

/**
 * Add the native contribution for one Account.
 *
 * The Account must already be a Team member: Group membership hangs on the Team
 * membership lifetime, and the composite foreign key would reject an orphan
 * anyway. Adding a native contribution to somebody a directory already supplied
 * preserves the existing horizon rather than replaying the history selector as a
 * policy rewrite.
 */
export async function addTeamGroupMemberForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        groupId: string;
        accountId: string;
        historyAccess: SessionHistoryAccess;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamGroupServiceResult<TeamGroupMemberMutationResultV1>> {
    const recheckAdmission = await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.actorAccountId, input.accountId], affectedAccountIds: [input.accountId], membershipChange: { kind: "teamGroupMembership", teamId: input.teamId, teamGroupIds: [input.groupId] } });
    await acquireTeamMutationLockInTx(tx, input.teamId);
    await recheckAdmission();
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const context = authorized.value;

    const row = await readGroupRowInTx(tx, input);
    if (!row) return denied("group_not_found");
    const rejection = authorizeGroupRosterInTx({ context, row });
    if (rejection) return denied(rejection);
    const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
    if (!qualified.ok) return qualified;

    const membership = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: input.teamId, accountId: input.accountId } },
        select: { id: true },
    });
    if (!membership) return denied("not_team_member");

    const applied = await applyTeamGroupContributionInTx(tx, {
        teamId: input.teamId,
        teamGroupId: row.id,
        teamMembershipId: membership.id,
        contribution: { kind: "native" },
        desired: "present",
        historyAccess: input.historyAccess,
    });

    const member = await projectGroupMemberInTx(tx, {
        teamGroupId: row.id,
        teamMembershipId: membership.id,
    });
    if (!member) return denied("group_not_found");
    if (applied.outcome !== "unchanged") {
        await publishTeamChangedInTx(tx, { teamId: input.teamId });
    }

    switch (applied.outcome) {
        case "added":
            return { ok: true, value: { status: "added", member } };
        case "contribution_added":
            return { ok: true, value: { status: "contribution_added", member } };
        default:
            return { ok: true, value: { status: "unchanged", member } };
    }
}

/**
 * Clear only the native contribution.
 *
 * If a directory still contributes, the person keeps Group access and the result
 * says so: an external-only row cannot be removed by pretending to clear a
 * native contribution, and the roster must not report a removal that did not
 * happen.
 */
export async function removeTeamGroupMemberForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        groupId: string;
        accountId: string;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamGroupServiceResult<TeamGroupMemberMutationResultV1>> {
    const recheckAdmission = await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.actorAccountId, input.accountId], affectedAccountIds: [input.accountId], membershipChange: { kind: "teamGroupMembership", teamId: input.teamId, teamGroupIds: [input.groupId] } });
    await acquireTeamMutationLockInTx(tx, input.teamId);
    await recheckAdmission();
    const authorized = await resolveTeamViewerContextInTx(tx, input);
    if (!authorized.ok) return authorized;
    const context = authorized.value;

    const row = await readGroupRowInTx(tx, input);
    if (!row) return denied("group_not_found");
    const rejection = authorizeGroupRosterInTx({ context, row });
    if (rejection) return denied(rejection);
    const qualified = await qualifyTeamViewerInTx(tx, { context, authentication: input.authentication });
    if (!qualified.ok) return qualified;

    const membership = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: input.teamId, accountId: input.accountId } },
        select: { id: true },
    });
    if (!membership) return denied("not_team_member");

    const applied = await applyTeamGroupContributionInTx(tx, {
        teamId: input.teamId,
        teamGroupId: row.id,
        teamMembershipId: membership.id,
        contribution: { kind: "native" },
        desired: "absent",
        // Removal never mints; the value is unreachable and carries no meaning.
        historyAccess: "from_membership",
    });
    if (applied.outcome !== "unchanged") {
        await publishTeamChangedInTx(tx, { teamId: input.teamId });
    }
    if (!applied.membershipRetained) {
        return {
            ok: true,
            value: applied.outcome === "unchanged"
                ? { status: "unchanged" }
                : { status: "removed" },
        };
    }

    const member = await projectGroupMemberInTx(tx, {
        teamGroupId: row.id,
        teamMembershipId: membership.id,
    });
    if (!member) return { ok: true, value: { status: "removed" } };
    return {
        ok: true,
        value: applied.outcome === "contribution_removed"
            ? { status: "contribution_removed", member }
            : { status: "unchanged", member },
    };
}
