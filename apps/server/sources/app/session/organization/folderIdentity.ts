import { SESSION_FOLDER_MAX_DEPTH } from "@happier-dev/protocol";

import type { SessionOrganizationTx } from "./types";

export interface ActiveSessionOrganizationFolderRef {
    readonly id: string;
    readonly folderKey: string;
}

interface ActiveSessionOrganizationFolderTreeRow {
    readonly id: string;
    readonly folderKey: string;
    readonly parentKey: string | null;
}

export async function findActiveSessionOrganizationFoldersById(params: Readonly<{
    tx: SessionOrganizationTx;
    accountId: string;
    folderIds: readonly string[];
}>): Promise<ActiveSessionOrganizationFolderRef[]> {
    const folderIds = Array.from(new Set(params.folderIds.filter((folderId) => folderId.length > 0)));
    if (folderIds.length === 0) return [];

    return await params.tx.sessionOrganizationFolder.findMany({
        where: {
            accountId: params.accountId,
            id: { in: folderIds },
            archivedAt: null,
        },
        select: {
            id: true,
            folderKey: true,
        },
    });
}

export async function resolveActiveSessionOrganizationFolderById(params: Readonly<{
    tx: SessionOrganizationTx;
    accountId: string;
    folderId: string;
}>): Promise<ActiveSessionOrganizationFolderRef | null> {
    const folders = await findActiveSessionOrganizationFoldersById({
        tx: params.tx,
        accountId: params.accountId,
        folderIds: [params.folderId],
    });
    return folders[0] ?? null;
}

export async function resolveActiveSessionOrganizationParentFolder(params: Readonly<{
    tx: SessionOrganizationTx;
    accountId: string;
    parentFolderId: string | null;
    parentFolderKey: string | null;
}>): Promise<ActiveSessionOrganizationFolderRef | null | { error: "invalid-parent-folder" }> {
    if (params.parentFolderId === null && params.parentFolderKey === null) {
        return null;
    }
    if (params.parentFolderId === null || params.parentFolderKey === null) {
        return { error: "invalid-parent-folder" };
    }

    const parent = await resolveActiveSessionOrganizationFolderById({
        tx: params.tx,
        accountId: params.accountId,
        folderId: params.parentFolderId,
    });
    if (!parent || parent.folderKey !== params.parentFolderKey) {
        return { error: "invalid-parent-folder" };
    }
    return parent;
}

function resolveFolderDepth(params: Readonly<{
    folderKey: string | null;
    foldersByKey: ReadonlyMap<string, ActiveSessionOrganizationFolderTreeRow>;
}>): number | null {
    let depth = 0;
    let folderKey = params.folderKey;
    const seen = new Set<string>();
    while (folderKey !== null) {
        if (seen.has(folderKey)) return null;
        seen.add(folderKey);
        const folder = params.foldersByKey.get(folderKey);
        if (!folder) return null;
        depth += 1;
        folderKey = folder.parentKey;
    }
    return depth;
}

export async function validateSessionOrganizationFolderParentChange(params: Readonly<{
    tx: SessionOrganizationTx;
    accountId: string;
    folderId: string | undefined;
    folderKey: string;
    parentFolderKey: string | null;
}>): Promise<boolean> {
    if (params.parentFolderKey === null) return true;
    if (params.parentFolderKey === params.folderKey) return false;

    const folders = await params.tx.sessionOrganizationFolder.findMany({
        where: { accountId: params.accountId, archivedAt: null },
        select: { id: true, folderKey: true, parentKey: true },
    }) as ActiveSessionOrganizationFolderTreeRow[];
    const foldersByKey = new Map(folders.map((folder) => [folder.folderKey, folder]));
    const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
    const existingFolder = params.folderId ? foldersById.get(params.folderId) ?? null : null;
    const currentFolderKey = existingFolder?.folderKey ?? params.folderKey;

    let ancestorKey: string | null = params.parentFolderKey;
    const seenAncestors = new Set<string>();
    while (ancestorKey !== null) {
        if (ancestorKey === currentFolderKey || ancestorKey === params.folderKey) return false;
        if (seenAncestors.has(ancestorKey)) return false;
        seenAncestors.add(ancestorKey);
        const ancestor = foldersByKey.get(ancestorKey);
        if (!ancestor) return false;
        ancestorKey = ancestor.parentKey;
    }

    const parentDepth = resolveFolderDepth({
        folderKey: params.parentFolderKey,
        foldersByKey,
    });
    return parentDepth !== null && parentDepth + 1 <= SESSION_FOLDER_MAX_DEPTH;
}
