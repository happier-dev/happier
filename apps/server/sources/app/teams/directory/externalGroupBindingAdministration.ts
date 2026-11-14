import { acquireTeamMutationAccountAdmissionInTx, withTeamSessionAccessEffectsInTx } from "../memberships/sessionAccessEffects";
import { randomUUID } from "node:crypto";
import type {
    TeamDirectorySafeErrorCodeV1,
    TeamErrorCodeV1,
    TeamExternalGroupBindingOwnerV1,
    TeamExternalGroupBindingRemoveInputV1,
    TeamExternalGroupBindingRemoveResultV1,
    TeamExternalGroupBindingSetInputV1,
    TeamExternalGroupBindingV1,
    TeamExternalGroupBindingsListInputV1,
    TeamExternalGroupBindingsPageV1,
} from "@happier-dev/protocol/teams";
import {
    decodeTeamKeysetCursorV1,
    encodeTeamKeysetCursorV1,
    readTeamKeysetIdV1,
    validateTeamGroupNameV1,
} from "@happier-dev/protocol/teams";

import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { acquireTeamMutationLockInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { authorizeTeamIdentityAdministrationInTx } from "../identity/teamIdentityAdministrationAuthority";
import {
    acquireExternalSourceAccountAdmissionInTx,
    applyExternalGroupContributionInTx,
    directoryGroupContributorIdentityWhere,
    removeExternalGroupBindingInTx,
} from "../memberships/externalFacts";
import { publishTeamChangedInTx } from "../teamChanges";
import { isDirectorySourceCompletedEvidenceAllowedInTx } from "./directorySourcePolicy";
import {
    prepareTeamGroupNameForDirectoryInitialWriteInTx,
    projectTeamGroupNameForRecipient,
} from "../groups/privateLabels";

const DEFAULT_PAGE_LIMIT = 50;

type Result<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: TeamErrorCodeV1 | TeamDirectorySafeErrorCodeV1 }>;

type BindingRow = Readonly<{
    id: string;
    teamId: string;
    directorySourceId: string | null;
    teamIdentityConnectionId: string | null;
    externalGroupId: string;
    bindingMode: "directory_created" | "native_target";
    group: Readonly<{ id: string; name: string; archivedAt: Date | null }>;
}>;

const bindingProjectionSelect = {
    id: true,
    teamId: true,
    directorySourceId: true,
    teamIdentityConnectionId: true,
    externalGroupId: true,
    bindingMode: true,
    group: { select: { id: true, name: true, archivedAt: true } },
} as const;

function projectBinding(row: BindingRow, recipientAccountId: string): TeamExternalGroupBindingV1 {
    let owner: TeamExternalGroupBindingOwnerV1;
    if (row.directorySourceId !== null) {
        owner = { kind: "directory_source", directorySourceId: row.directorySourceId };
    } else if (row.teamIdentityConnectionId !== null) {
        owner = { kind: "identity_connection", teamIdentityConnectionId: row.teamIdentityConnectionId };
    } else {
        throw new TypeError(`External Group binding ${row.id} has no owner`);
    }
    return {
        v: 1,
        id: row.id,
        teamId: row.teamId,
        owner,
        externalGroupId: row.externalGroupId,
        mode: row.bindingMode,
        target: {
            teamGroupId: row.group.id,
            name: projectTeamGroupNameForRecipient({
                serialized: row.group.name,
                recipientAccountId,
            }),
            archivedAt: row.group.archivedAt?.getTime() ?? null,
        },
    };
}

async function authorizeInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{ teamId: string; actorAccountId: string }>,
    operation: "view" | "mutate" = "mutate",
): Promise<Result<Readonly<{ defaultSessionHistoryAccess: "all_existing" | "from_membership" }>>> {
    const identityAuthority = await authorizeTeamIdentityAdministrationInTx(tx, input, operation);
    if (!identityAuthority.ok) return identityAuthority;
    const context = identityAuthority.actor;
    if (context.team.archivedAt !== null) return { ok: false, error: "team_archived" };
    if (!context.teamCapabilities.manageGroups || !context.teamCapabilities.manageAuthentication) {
        return { ok: false, error: "team_forbidden" };
    }
    return {
        ok: true,
        value: { defaultSessionHistoryAccess: context.team.defaultSessionHistoryAccess },
    };
}

function ownerWhere(owner: TeamExternalGroupBindingOwnerV1) {
    return owner.kind === "directory_source"
        ? { directorySourceId: owner.directorySourceId }
        : { teamIdentityConnectionId: owner.teamIdentityConnectionId };
}

function ownerFromListInput(input: TeamExternalGroupBindingsListInputV1): TeamExternalGroupBindingOwnerV1 {
    return input.ownerKind === "directory_source"
        ? { kind: "directory_source", directorySourceId: input.directorySourceId }
        : { kind: "identity_connection", teamIdentityConnectionId: input.teamIdentityConnectionId };
}

async function validateOwnerInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        owner: TeamExternalGroupBindingOwnerV1;
        requireOperational: boolean;
        requireActiveDirectoryGroup?: string;
    }>,
): Promise<Result<Readonly<{ externalDisplayName?: string }>>> {
    if (input.owner.kind === "directory_source") {
        const source = await tx.teamDirectorySource.findFirst({
            where: {
                id: input.owner.directorySourceId,
                teamId: input.teamId,
            },
            select: { id: true, kind: true, state: true, activeReconcileRunId: true },
        });
        if (!source) return { ok: false, error: "directory_group_mapping_invalid" };
        if (input.requireOperational && !await isDirectorySourceCompletedEvidenceAllowedInTx(tx, source)) {
            return { ok: false, error: "directory_group_mapping_invalid" };
        }
        if (input.requireActiveDirectoryGroup !== undefined) {
            const group = await tx.teamDirectoryGroup.findUnique({
                where: {
                    directorySourceId_externalGroupId: {
                        directorySourceId: source.id,
                        externalGroupId: input.requireActiveDirectoryGroup,
                    },
                },
                select: { state: true, externalDisplayName: true },
            });
            if (!group || group.state !== "active") {
                return { ok: false, error: "directory_group_mapping_invalid" };
            }
            return { ok: true, value: { externalDisplayName: group.externalDisplayName } };
        }
        return { ok: true, value: {} };
    }
    const connection = await tx.teamIdentityConnection.findFirst({
        where: {
            id: input.owner.teamIdentityConnectionId,
            teamId: input.teamId,
            ...(input.requireOperational ? { enabled: true } : {}),
        },
        select: { id: true },
    });
    return connection
        ? { ok: true, value: {} }
        : { ok: false, error: "directory_group_mapping_invalid" };
}

export async function listExternalGroupBindingsForActor(
    input: TeamExternalGroupBindingsListInputV1 & Partial<TeamOperationAuthenticationContext> & Readonly<{ actorAccountId: string }>,
): Promise<Result<TeamExternalGroupBindingsPageV1>> {
    return inTx(async (tx) => {
        const authorized = await authorizeInTx(tx, input, "view");
        if (!authorized.ok) return authorized;
        const owner = ownerFromListInput(input);
        const validOwner = await validateOwnerInTx(tx, {
            teamId: input.teamId,
            owner,
            requireOperational: false,
        });
        if (!validOwner.ok) return validOwner;
        const queryKey = owner.kind === "directory_source"
            ? `external-group-bindings:${input.teamId}:directory:${owner.directorySourceId}`
            : `external-group-bindings:${input.teamId}:connection:${owner.teamIdentityConnectionId}`;
        let cursorId: string | null = null;
        if (input.cursor) {
            const decoded = decodeTeamKeysetCursorV1(input.cursor, queryKey);
            cursorId = decoded.status === "ok" ? readTeamKeysetIdV1(decoded.parts[0]) : null;
            if (cursorId === null) return { ok: false, error: "invalid_team_cursor" };
        }
        const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
        const rows = await tx.teamExternalGroupBinding.findMany({
            where: {
                teamId: input.teamId,
                ...ownerWhere(owner),
                ...(cursorId ? { id: { gt: cursorId } } : {}),
            },
            orderBy: { id: "asc" },
            take: limit + 1,
            select: bindingProjectionSelect,
        });
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
            ok: true,
            value: {
                items: pageRows.map((row) => projectBinding(row, input.actorAccountId)),
                nextCursor: rows.length > limit && last
                    ? encodeTeamKeysetCursorV1({ queryKey, parts: [last.id] })
                    : null,
            },
        };
    });
}

export async function setExternalGroupBindingForActor(
    input: TeamExternalGroupBindingSetInputV1 & Partial<TeamOperationAuthenticationContext> & Readonly<{ actorAccountId: string }>,
): Promise<Result<TeamExternalGroupBindingV1>> {
    try {
        return await inTx(async (tx) => {
            const admission = await acquireExternalSourceAccountAdmissionInTx(tx, { owner: input.owner, actorAccountIds: [input.actorAccountId] });
            const recheckAdmission = admission?.teamId === input.teamId ? admission.recheck : await acquireTeamMutationAccountAdmissionInTx(tx, {
                teamId: input.teamId, accountIds: [input.actorAccountId],
                membershipChange: { kind: "teamMembership", teamId: input.teamId },
            });
            await acquireTeamMutationLockInTx(tx, input.teamId);
            await recheckAdmission();
            const authorized = await authorizeInTx(tx, input);
            if (!authorized.ok) return authorized;
            const validOwner = await validateOwnerInTx(tx, {
                teamId: input.teamId,
                owner: input.owner,
                requireOperational: true,
                ...(input.owner.kind === "directory_source"
                    ? { requireActiveDirectoryGroup: input.externalGroupId }
                    : {}),
            });
            if (!validOwner.ok) return validOwner;
            if (input.owner.kind === "identity_connection" && input.target.kind === "directory_created") {
                return { ok: false, error: "directory_group_mapping_invalid" };
            }

            const existing = await tx.teamExternalGroupBinding.findFirst({
                where: { teamId: input.teamId, ...ownerWhere(input.owner), externalGroupId: input.externalGroupId },
                select: bindingProjectionSelect,
            });
            const sameTarget = existing && (
                input.target.kind === "directory_created"
                    ? existing.bindingMode === "directory_created"
                    : existing.bindingMode === "native_target" && existing.group.id === input.target.teamGroupId
            );

            const members = input.owner.kind === "directory_source"
                ? await tx.teamDirectoryGroupMember.findMany({
                    where: {
                        directorySourceId: input.owner.directorySourceId,
                        externalGroupId: input.externalGroupId,
                        identity: directoryGroupContributorIdentityWhere(),
                    },
                    select: {
                        identity: {
                            select: {
                                boundAccountId: true,
                                teamMembershipId: true,
                                teamMembership: { select: { accountId: true } },
                            },
                        },
                    },
                })
                : [];
            // A bound Account ID is only an address. When the identity also
            // manages a Team-membership lifetime, both sides must identify the
            // same Account before this transaction creates a binding. An
            // identity that manages no lifetime is not an error: the person may
            // be natively invited or admitted by another directory, and the
            // contribution owner below still requires a current membership.
            if (members.some(({ identity }) => (
                identity.boundAccountId === null
                || (identity.teamMembershipId !== null
                    && identity.teamMembership?.accountId !== identity.boundAccountId)
            ))) {
                return { ok: false, error: "directory_group_mapping_invalid" };
            }

            let targetGroup: Readonly<{ id: string; name: string; archivedAt: Date | null }>;
            let binding = sameTarget ? existing : null;
            if (binding) {
                targetGroup = binding.group;
            } else if (input.target.kind === "native_target") {
                const group = await tx.teamGroup.findFirst({
                    where: { id: input.target.teamGroupId, teamId: input.teamId, archivedAt: null },
                    select: { id: true, name: true, archivedAt: true },
                });
                if (!group) return { ok: false, error: "directory_group_mapping_invalid" };
                targetGroup = group;
            } else {
                const candidate = validateTeamGroupNameV1(validOwner.value.externalDisplayName ?? "");
                if (candidate.status !== "ok") return { ok: false, error: "directory_group_mapping_invalid" };
                const groupId = randomUUID();
                const name = await prepareTeamGroupNameForDirectoryInitialWriteInTx({
                    tx,
                    authorAccountId: input.actorAccountId,
                    teamId: input.teamId,
                    groupId,
                    value: candidate.name,
                });
                if (name.kind !== "ready") return { ok: false, error: "directory_group_mapping_invalid" };
                targetGroup = await tx.teamGroup.create({
                    data: {
                        id: groupId,
                        teamId: input.teamId,
                        name: name.serialized,
                    },
                    select: { id: true, name: true, archivedAt: true },
                });
            }

            const previousMembers = existing ? await tx.teamGroupMembership.findMany({
                where: { teamGroupId: existing.group.id },
                select: { teamMembership: { select: { accountId: true } } },
            }) : [];
            const accountIds = [
                ...members.flatMap(member => member.identity.boundAccountId ?? []),
                ...previousMembers.map(member => member.teamMembership.accountId),
            ];
            return withTeamSessionAccessEffectsInTx(tx, {
                teamId: input.teamId,
                accountIds,
                // Exact contribution state decides whether this mapping creates
                // or ends an effective Group relationship. A same-target replay
                // must not pre-upgrade the shared capture.
            }, async (sessionAccessImpacts) => {
                if (!binding) {
                    if (existing) {
                        await removeExternalGroupBindingInTx(tx, {
                            teamId: input.teamId,
                            bindingId: existing.id,
                            publishChange: false,
                            sessionAccessImpacts,
                        });
                    }
                    binding = await tx.teamExternalGroupBinding.create({
                        data: {
                            teamId: input.teamId,
                            teamGroupId: targetGroup.id,
                            ...ownerWhere(input.owner),
                            externalGroupId: input.externalGroupId,
                            bindingMode: input.target.kind === "directory_created"
                                ? "directory_created"
                                : "native_target",
                        },
                        select: bindingProjectionSelect,
                    });
                }

                if (input.owner.kind === "directory_source") {
                    for (const member of members) {
                        if (!member.identity.boundAccountId) continue;
                        await applyExternalGroupContributionInTx(tx, {
                            teamId: input.teamId,
                            groupId: binding.group.id,
                            accountId: member.identity.boundAccountId,
                            externalGroupBindingId: binding.id,
                            desired: "present",
                            historyAccess: authorized.value.defaultSessionHistoryAccess,
                            sessionAccessImpacts,
                            // child 05 §5: one audience, one publication below.
                            publishChange: false,
                        });
                    }
                }
                await publishTeamChangedInTx(tx, { teamId: input.teamId });
                return { ok: true, value: projectBinding(binding, input.actorAccountId) };
            });
        }, { isolationLevel: "ReadCommitted" /* The outer Team guard precedes the fresh projected roster, binding and contribution census. */ });
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) {
            return { ok: false, error: "directory_group_mapping_invalid" };
        }
        throw error;
    }
}

export async function removeExternalGroupBindingForActor(
    input: TeamExternalGroupBindingRemoveInputV1 & Partial<TeamOperationAuthenticationContext> & Readonly<{ actorAccountId: string }>,
): Promise<Result<TeamExternalGroupBindingRemoveResultV1>> {
    return inTx(async (tx) => {
        const bindingOwner = await tx.teamExternalGroupBinding.findUnique({
            where: { id: input.bindingId }, select: { directorySourceId: true, teamIdentityConnectionId: true },
        });
        const admission = bindingOwner?.directorySourceId
            ? await acquireExternalSourceAccountAdmissionInTx(tx, { owner: { kind: "directory_source", directorySourceId: bindingOwner.directorySourceId }, actorAccountIds: [input.actorAccountId] })
            : bindingOwner?.teamIdentityConnectionId
                ? await acquireExternalSourceAccountAdmissionInTx(tx, { owner: { kind: "identity_connection", teamIdentityConnectionId: bindingOwner.teamIdentityConnectionId }, actorAccountIds: [input.actorAccountId] })
                : null;
        const recheckAdmission = admission?.teamId === input.teamId ? admission.recheck : await acquireTeamMutationAccountAdmissionInTx(tx, {
            teamId: input.teamId, accountIds: [input.actorAccountId],
            membershipChange: { kind: "teamMembership", teamId: input.teamId },
        });
        await acquireTeamMutationLockInTx(tx, input.teamId);
        await recheckAdmission();
        const authorized = await authorizeInTx(tx, input);
        if (!authorized.ok) return authorized;
        const removed = await removeExternalGroupBindingInTx(tx, {
            teamId: input.teamId,
            bindingId: input.bindingId,
        });
        return {
            ok: true,
            value: { v: 1, outcome: removed.status === "removed" ? "removed" : "already_absent" },
        };
    }, { isolationLevel: "ReadCommitted" /* The outer Team guard precedes current authority and the remaining contribution union. */ });
}
