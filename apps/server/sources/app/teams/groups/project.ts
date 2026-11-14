import type {
    TeamExternalGroupBindingOwnerV1,
    TeamGroupCapabilitiesV1,
    TeamGroupManagementV1,
    TeamGroupMemberV1,
    TeamGroupV1,
} from "@happier-dev/protocol/teams";

import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
} from "@/app/account/profile/accountDisplayProfile";
import { TeamExternalGroupBindingMode } from "@/storage/enums.generated";
import type { Tx } from "@/storage/inTx";
import { sessionHistoryAccessOf } from "../memberships/sessionHistory";
import { projectTeamGroupNameForRecipient } from "./privateLabels";

/**
 * The Group row and the two facts its metadata lifecycle depends on: whether a
 * directory created it, and what to call that source. Roster contribution is
 * deliberately not part of this select — it is additive and independent of who
 * owns the Group's name.
 */
export const TEAM_GROUP_ROW_SELECT = {
    id: true,
    teamId: true,
    name: true,
    description: true,
    archivedAt: true,
} as const;

export type TeamGroupRow = Readonly<{
    id: string;
    teamId: string;
    name: string;
    description: string | null;
    archivedAt: Date | null;
}>;

/**
 * The label a binding may be presented under.
 *
 * A binding names either a directory source or an identity connection; the
 * display name comes from that owner's own row rather than being copied onto the
 * binding, so a renamed source is renamed everywhere at once.
 */
const EXTERNAL_BINDING_SELECT = {
    id: true,
    bindingMode: true,
    directorySource: { select: { id: true, displayName: true } },
    identityConnection: { select: { id: true, providerInstance: { select: { displayName: true } } } },
} as const;

export type TeamExternalBindingLabel = Readonly<{
    id: string;
    bindingMode: TeamExternalGroupBindingMode;
    label: string;
    owner: TeamExternalGroupBindingOwnerV1;
}>;

function projectExternalBindingOwner(binding: Readonly<{
    directorySource: Readonly<{ id: string }> | null;
    identityConnection: Readonly<{ id: string }> | null;
}>): TeamExternalGroupBindingOwnerV1 {
    if (binding.directorySource) {
        return { kind: "directory_source", directorySourceId: binding.directorySource.id };
    }
    if (binding.identityConnection) {
        return { kind: "identity_connection", teamIdentityConnectionId: binding.identityConnection.id };
    }
    // Persistence requires exactly one owner. Refuse to publish an invented
    // navigation target if provider drift ever violates that invariant.
    throw new Error("external_group_binding_owner_missing");
}

/**
 * Every external binding that targets one Group, with its display label.
 *
 * A Group has at most a handful of bindings, so this is read once per page and
 * shared by the Group projection and its roster rather than joined per member.
 */
export async function readTeamGroupBindingsInTx(
    tx: Tx,
    input: Readonly<{ teamGroupId: string }>,
): Promise<readonly TeamExternalBindingLabel[]> {
    const bindings = await tx.teamExternalGroupBinding.findMany({
        where: { teamGroupId: input.teamGroupId },
        orderBy: { id: "asc" },
        select: EXTERNAL_BINDING_SELECT,
    });
    return bindings.map((binding) => ({
        id: binding.id,
        bindingMode: binding.bindingMode,
        label: binding.directorySource?.displayName
            ?? binding.identityConnection?.providerInstance.displayName
            ?? "",
        owner: projectExternalBindingOwner(binding),
    }));
}

/** Read binding labels for a whole Group page in one query. */
export async function readTeamGroupBindingsForPageInTx(
    tx: Tx,
    input: Readonly<{ teamGroupIds: readonly string[] }>,
): Promise<ReadonlyMap<string, readonly TeamExternalBindingLabel[]>> {
    if (input.teamGroupIds.length === 0) return new Map();
    const bindings = await tx.teamExternalGroupBinding.findMany({
        where: { teamGroupId: { in: [...input.teamGroupIds] } },
        orderBy: [{ teamGroupId: "asc" }, { id: "asc" }],
        select: { teamGroupId: true, ...EXTERNAL_BINDING_SELECT },
    });
    const byGroup = new Map<string, TeamExternalBindingLabel[]>();
    for (const binding of bindings) {
        const projected = {
            id: binding.id,
            bindingMode: binding.bindingMode,
            label: binding.directorySource?.displayName
                ?? binding.identityConnection?.providerInstance.displayName
                ?? "",
            owner: projectExternalBindingOwner(binding),
        };
        const current = byGroup.get(binding.teamGroupId);
        if (current) current.push(projected);
        else byGroup.set(binding.teamGroupId, [projected]);
    }
    return byGroup;
}

/**
 * Who owns this Group's metadata lifecycle.
 *
 * At most one `directory_created` binding may target a Group, so this is a
 * single answer rather than a precedence rule. Every other binding contributes
 * roster membership only and leaves the Group natively managed.
 */
export function projectTeamGroupManagementV1(
    bindings: readonly TeamExternalBindingLabel[],
): TeamGroupManagementV1 {
    const owner = bindings.find(
        (binding) => binding.bindingMode === TeamExternalGroupBindingMode.directory_created,
    );
    return owner
        ? { kind: "directory_created", bindingId: owner.id, label: owner.label, owner: owner.owner }
        : { kind: "native" };
}

/**
 * What the viewer may do to this Group.
 *
 * Metadata lifecycle and roster editing are deliberately separate booleans: a
 * directory-created Group is still natively editable as a roster, and a
 * native-target Group keeps native archive authority even while external sources
 * contribute members. Collapsing them into one "managed" flag is exactly the
 * conflation the source-disposition contract exists to avoid.
 */
export function resolveTeamGroupCapabilitiesV1(input: Readonly<{
    manageGroups: boolean;
    teamArchivedAt: Date | null;
    group: Readonly<{ archivedAt: Date | null }>;
    management: TeamGroupManagementV1;
}>): TeamGroupCapabilitiesV1 {
    if (!input.manageGroups || input.teamArchivedAt !== null) {
        return { updateMetadata: false, archive: false, restore: false, manageNativeMembers: false };
    }
    const archived = input.group.archivedAt !== null;
    const nativeMetadata = input.management.kind === "native";
    return {
        updateMetadata: nativeMetadata && !archived,
        archive: nativeMetadata && !archived,
        restore: nativeMetadata && archived,
        manageNativeMembers: !archived,
    };
}

export function projectTeamGroupV1(input: Readonly<{
    row: TeamGroupRow;
    recipientAccountId: string;
    memberCount: number;
    manageGroups: boolean;
    teamArchivedAt: Date | null;
    bindings: readonly TeamExternalBindingLabel[];
}>): TeamGroupV1 {
    const management = projectTeamGroupManagementV1(input.bindings);
    return {
        v: 1,
        id: input.row.id,
        teamId: input.row.teamId,
        name: projectTeamGroupNameForRecipient({
            serialized: input.row.name,
            recipientAccountId: input.recipientAccountId,
        }),
        description: input.row.description,
        archivedAt: input.row.archivedAt?.getTime() ?? null,
        memberCount: input.memberCount,
        management,
        capabilities: resolveTeamGroupCapabilitiesV1({
            manageGroups: input.manageGroups,
            teamArchivedAt: input.teamArchivedAt,
            group: input.row,
            management,
        }),
    };
}

/**
 * One effective Group-membership row, joined to the member it belongs to and the
 * contributions that keep it alive.
 */
export const TEAM_GROUP_MEMBERSHIP_ROW_SELECT = {
    teamGroupId: true,
    teamMembershipId: true,
    nativeContribution: true,
    sessionAccessStartsAt: true,
    createdAt: true,
    teamMembership: {
        select: {
            id: true,
            accountId: true,
            account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT },
        },
    },
    externalContributions: { select: { externalGroupBindingId: true } },
} as const;

export type TeamGroupMembershipRow = Readonly<{
    teamGroupId: string;
    teamMembershipId: string;
    nativeContribution: boolean;
    sessionAccessStartsAt: Date | null;
    createdAt: Date;
    teamMembership: Readonly<{
        id: string;
        accountId: string;
        account: Readonly<{
            id: string;
            name: string | null;
            firstName: string | null;
            lastName: string | null;
            username: string | null;
            avatar: unknown;
        }>;
    }>;
    externalContributions: readonly Readonly<{ externalGroupBindingId: string }>[];
}>;

/**
 * Project one Group roster row.
 *
 * The contribution provenance is what lets the roster tell the truth about a
 * native removal that will not end access because a directory still contributes,
 * and it carries the binding owner's exact canonical coordinate so the UI can
 * link to that source's settings without resolving or inferring ownership.
 * It is navigation, never resource authorization.
 */
export function projectTeamGroupMemberV1(input: Readonly<{
    row: TeamGroupMembershipRow;
    bindings: readonly TeamExternalBindingLabel[];
}>): TeamGroupMemberV1 {
    const bindingById = new Map(input.bindings.map((binding) => [binding.id, binding]));
    return {
        accountId: input.row.teamMembership.accountId,
        membershipId: input.row.teamMembership.id,
        account: projectAccountDisplayProfileV1(input.row.teamMembership.account),
        historyAccess: sessionHistoryAccessOf(input.row.sessionAccessStartsAt),
        contributions: {
            native: input.row.nativeContribution,
            external: input.row.externalContributions.map((contribution) => {
                const binding = bindingById.get(contribution.externalGroupBindingId);
                if (!binding) throw new Error("external_group_contribution_binding_missing");
                return {
                    bindingId: contribution.externalGroupBindingId,
                    label: binding.label,
                    owner: binding.owner,
                };
            }),
        },
    };
}
