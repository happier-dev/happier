import { markAccountChanged } from "@/app/changes/markAccountChanged";
import type { Tx } from "@/storage/inTx";

export type SessionOrganizationChangeScope =
    | "pins"
    | "folders"
    | "folderAssignments"
    | "tags"
    | "tagAssignments"
    | "order"
    | "labels"
    | "attentionStandings";

export function buildSessionOrganizationHint(params: Readonly<{
    scope: SessionOrganizationChangeScope;
    sessionIds?: readonly string[];
    folderIds?: readonly string[];
    tagIds?: readonly string[];
    scopeKeys?: readonly string[];
}>) {
    return {
        sessionOrganization: true,
        scope: params.scope,
        ...(params.sessionIds ? { sessionIds: [...params.sessionIds] } : {}),
        ...(params.folderIds ? { folderIds: [...params.folderIds] } : {}),
        ...(params.tagIds ? { tagIds: [...params.tagIds] } : {}),
        ...(params.scopeKeys ? { scopeKeys: [...params.scopeKeys] } : {}),
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
        scopeKeys?: readonly string[];
    }>,
): Promise<number> {
    await bumpSessionOrganizationCheckpoint(tx, params.accountId);
    return await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "session-organization",
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
    }>,
): Promise<void> {
    await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "session-organization-folders",
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
): Promise<number> {
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
): Promise<number> {
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
