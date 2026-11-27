import { acquireAccountChangePublicationLocksInTx, markAccountChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { buildWorkflowFolderAssignmentChangeEntityIdV1, SESSION_ORGANIZATION_FOLDERS_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { Tx } from "@/storage/inTx";

/**
 * Counts, hierarchy and whole replacements belong to one Account aggregate.
 * Exclude content admission too: births insert folder/tag assignments and
 * encryption/lifecycle owners already use the same exclusive Account fence.
 * Select the strongest complete cohort before any read, never by an upgrade.
 * Birth placement retains its surrounding content admission and current checks.
 */
export async function acquireSessionOrganizationMutationAdmissionInTx(
    tx: Tx,
    accountId: string,
    sessionId?: string,
): Promise<void> {
    if (sessionId !== undefined) {
        await acquireSessionAccountCursorLocksInTx(tx, [sessionId], [accountId], { intent: "exclusive" });
    } else {
        await acquireAccountChangePublicationLocksInTx(tx, [accountId], { includeSingleAccount: true, intent: "exclusive" });
    }
}

export type SessionOrganizationChangeScope =
    | "pins"
    | "folders"
    | "folderAssignments"
    | "tags"
    | "tagAssignments"
    | "order"
    | "labels"
    | "attentionStandings"
    | "sessionAppearances"
    | "resourceSpaceMemberships";

export function buildSessionOrganizationHint(params: Readonly<{
    scope: SessionOrganizationChangeScope;
    sessionIds?: readonly string[];
    folderIds?: readonly string[];
    tagIds?: readonly string[];
    deletedTagIds?: readonly string[];
    scopeKeys?: readonly string[];
    spaceIds?: readonly string[];
    resourceIds?: readonly string[];
}>) {
    return {
        sessionOrganization: true,
        scope: params.scope,
        ...(params.sessionIds ? { sessionIds: [...params.sessionIds] } : {}),
        ...(params.folderIds ? { folderIds: [...params.folderIds] } : {}),
        ...(params.tagIds ? { tagIds: [...params.tagIds] } : {}),
        ...(params.deletedTagIds ? { deletedTagIds: [...params.deletedTagIds] } : {}),
        ...(params.scopeKeys ? { scopeKeys: [...params.scopeKeys] } : {}),
        ...(params.spaceIds ? { spaceIds: [...params.spaceIds] } : {}),
        ...(params.resourceIds ? { resourceIds: [...params.resourceIds] } : {}),
    };
}

export function buildSessionFolderAssignmentHint(params: Readonly<{
    sessionId: string;
    folderId: string | null;
}>) {
    return {
        sessionFolderAssignment: true,
        sessionOrganization: true,
        scope: "folderAssignments",
        sessionIds: [params.sessionId],
        ...(params.folderId ? { folderIds: [params.folderId] } : {}),
        folderId: params.folderId,
    };
}

export function buildBulkSessionFolderAssignmentHint(params: Readonly<{
    folderIds: readonly string[];
    toFolderId: string | null;
}>) {
    return {
        sessionFolderAssignments: true,
        sessionOrganization: true,
        scope: "folderAssignments",
        folderIds: [...params.folderIds],
        toFolderId: params.toFolderId,
    };
}

export async function bumpSessionOrganizationCheckpoint(
    tx: Tx,
    accountId: string,
): Promise<number> {
    const checkpoint = await tx.sessionOrganizationCheckpoint.upsert({
        where: { accountId },
        create: { accountId, version: 1 },
        update: { version: { increment: 1 } },
    });
    return checkpoint.version;
}

export async function markSessionOrganizationChanged(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        scope: SessionOrganizationChangeScope;
        sessionIds?: readonly string[];
        folderIds?: readonly string[];
        tagIds?: readonly string[];
        deletedTagIds?: readonly string[];
        scopeKeys?: readonly string[];
        spaceIds?: readonly string[];
        resourceIds?: readonly string[];
    }>,
): Promise<AccountChangePublication> {
    await bumpSessionOrganizationCheckpoint(tx, params.accountId);
    return await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        // Folder structure and Workflow moves must survive later Session-only edits in the coalesced feed.
        entityId: params.scope === "folders" ? SESSION_ORGANIZATION_FOLDERS_CHANGE_ENTITY_ID_V1
            : params.scope === "folderAssignments" && params.resourceIds?.length === 1
                ? buildWorkflowFolderAssignmentChangeEntityIdV1(params.resourceIds[0]!) : "session-organization",
        hint: buildSessionOrganizationHint(params),
    });
}

export async function markSessionOrganizationDisplayMigrationChanged(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        folderIds: readonly string[];
        tagIds: readonly string[];
        scopeKeys: readonly string[];
        sessionIds?: readonly string[];
    }>,
): Promise<void> {
    if (params.sessionIds?.length) {
        await markAccountChanged(tx, {
            accountId: params.accountId,
            kind: "account",
            entityId: "session-organization-appearances",
            hint: buildSessionOrganizationHint({ scope: "sessionAppearances", sessionIds: params.sessionIds }),
        });
    }
    await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: SESSION_ORGANIZATION_FOLDERS_CHANGE_ENTITY_ID_V1,
        hint: buildSessionOrganizationHint({
            scope: "folders",
            folderIds: params.folderIds,
        }),
    });
    await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "session-organization-tags",
        hint: buildSessionOrganizationHint({
            scope: "tags",
            tagIds: params.tagIds,
        }),
    });
    await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "session-organization-labels",
        hint: buildSessionOrganizationHint({
            scope: "labels",
            scopeKeys: params.scopeKeys,
        }),
    });
}

export async function markSessionFolderAssignmentChanged(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        sessionId: string;
        folderId: string | null;
    }>,
): Promise<AccountChangePublication> {
    await bumpSessionOrganizationCheckpoint(tx, params.accountId);
    return await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "session",
        entityId: params.sessionId,
        hint: buildSessionFolderAssignmentHint({
            sessionId: params.sessionId,
            folderId: params.folderId,
        }),
    });
}

export async function markBulkSessionFolderAssignmentsChanged(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        folderIds: readonly string[];
        toFolderId: string | null;
    }>,
): Promise<AccountChangePublication> {
    await bumpSessionOrganizationCheckpoint(tx, params.accountId);
    return await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "session-folder-assignments",
        hint: buildBulkSessionFolderAssignmentHint({
            folderIds: params.folderIds,
            toFolderId: params.toFolderId,
        }),
    });
}
