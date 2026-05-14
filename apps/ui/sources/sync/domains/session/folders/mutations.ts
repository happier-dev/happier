import { randomUUID } from '@/platform/randomUUID';

import { makeSiblingUniqueSessionFolderName, normalizeSessionFolderName } from './names';
import { normalizeSessionFolders } from './normalize';
import type { SessionFolderV1, SessionFoldersV1, SessionFolderWorkspaceRefV1 } from './types';
import { buildSessionFolderWorkspaceRefKey } from './workspaceRefs';

export type CreateSessionFolderResult = Readonly<{
    next: SessionFoldersV1;
    folder: SessionFolderV1;
}>;

export function createSessionFolder(params: Readonly<{
    current: SessionFoldersV1;
    workspace: SessionFolderWorkspaceRefV1;
    renderWorkspaceKey?: string;
    parentId: string | null;
    name: string;
    now: number;
    id?: string;
}>): CreateSessionFolderResult {
    const workspaceKey = buildSessionFolderWorkspaceRefKey(params.workspace);
    const siblingNames = new Set(
        params.current.folders
            .filter((folder) => (
                buildSessionFolderWorkspaceRefKey(folder.workspace) === workspaceKey
                && folder.parentId === params.parentId
            ))
            .map((folder) => folder.name.toLocaleLowerCase()),
    );
    const name = makeSiblingUniqueSessionFolderName(normalizeSessionFolderName(params.name) ?? 'Folder', siblingNames);
    const folder: SessionFolderV1 = {
        id: params.id ?? randomUUID(),
        workspace: params.workspace,
        ...(params.renderWorkspaceKey ? { renderWorkspaceKey: params.renderWorkspaceKey } : {}),
        parentId: params.parentId,
        name,
        createdAt: params.now,
        updatedAt: params.now,
    };
    const next = normalizeSessionFolders({ v: 1, folders: [...params.current.folders, folder] });
    const normalizedFolder = next.folders.find((candidate) => candidate.id === folder.id) ?? folder;
    return { next, folder: normalizedFolder };
}

export function deleteSessionFolder(params: Readonly<{
    current: SessionFoldersV1;
    folderId: string;
}>): Readonly<{
    next: SessionFoldersV1;
    deletedFolderIds: readonly string[];
    replacementFolderId: string | null;
}> {
    const byId = new Map(params.current.folders.map((folder) => [folder.id, folder] as const));
    const target = byId.get(params.folderId);
    if (!target) {
        return { next: params.current, deletedFolderIds: [], replacementFolderId: null };
    }

    const deleted = new Set<string>();
    const collect = (folderId: string) => {
        deleted.add(folderId);
        for (const folder of params.current.folders) {
            if (folder.parentId === folderId && !deleted.has(folder.id)) collect(folder.id);
        }
    };
    collect(target.id);

    return {
        next: normalizeSessionFolders({
            v: 1,
            folders: params.current.folders.filter((folder) => !deleted.has(folder.id)),
        }),
        deletedFolderIds: Array.from(deleted),
        replacementFolderId: target.parentId,
    };
}

export function renameSessionFolder(params: Readonly<{
    current: SessionFoldersV1;
    folderId: string;
    name: string;
    now: number;
}>): Readonly<{
    next: SessionFoldersV1;
    folder: SessionFolderV1 | null;
}> {
    const target = params.current.folders.find((folder) => folder.id === params.folderId);
    if (!target) {
        return { next: params.current, folder: null };
    }

    const workspaceKey = buildSessionFolderWorkspaceRefKey(target.workspace);
    const siblingNames = new Set(
        params.current.folders
            .filter((folder) => (
                folder.id !== target.id
                && buildSessionFolderWorkspaceRefKey(folder.workspace) === workspaceKey
                && folder.parentId === target.parentId
            ))
            .map((folder) => folder.name.toLocaleLowerCase()),
    );
    const name = makeSiblingUniqueSessionFolderName(normalizeSessionFolderName(params.name) ?? target.name, siblingNames);
    const next = normalizeSessionFolders({
        v: 1,
        folders: params.current.folders.map((folder) => folder.id === target.id
            ? { ...folder, name, updatedAt: params.now }
            : folder),
    });
    return {
        next,
        folder: next.folders.find((folder) => folder.id === target.id) ?? null,
    };
}

function isDescendantFolder(
    candidateId: string,
    ancestorId: string,
    byId: ReadonlyMap<string, SessionFolderV1>,
): boolean {
    let current = byId.get(candidateId);
    const seen = new Set<string>();
    while (current?.parentId) {
        if (current.parentId === ancestorId) return true;
        if (seen.has(current.parentId)) return false;
        seen.add(current.parentId);
        current = byId.get(current.parentId);
    }
    return false;
}

export function moveSessionFolder(params: Readonly<{
    current: SessionFoldersV1;
    folderId: string;
    parentId: string | null;
    beforeFolderId?: string | null;
    afterFolderId?: string | null;
    now: number;
}>): Readonly<{
    next: SessionFoldersV1;
    folder: SessionFolderV1 | null;
}> {
    const byId = new Map(params.current.folders.map((folder) => [folder.id, folder] as const));
    const target = byId.get(params.folderId);
    if (!target) {
        return { next: params.current, folder: null };
    }
    if (params.parentId === target.id) {
        return { next: params.current, folder: null };
    }
    const parent = params.parentId ? byId.get(params.parentId) ?? null : null;
    if (params.parentId && !parent) {
        return { next: params.current, folder: null };
    }
    if (parent && buildSessionFolderWorkspaceRefKey(parent.workspace) !== buildSessionFolderWorkspaceRefKey(target.workspace)) {
        return { next: params.current, folder: null };
    }
    if (parent && isDescendantFolder(parent.id, target.id, byId)) {
        return { next: params.current, folder: null };
    }
    const before = params.beforeFolderId ? byId.get(params.beforeFolderId) ?? null : null;
    const after = params.afterFolderId ? byId.get(params.afterFolderId) ?? null : null;
    if (
        (params.beforeFolderId && !before)
        || (params.afterFolderId && !after)
        || before?.id === target.id
        || after?.id === target.id
    ) {
        return { next: params.current, folder: null };
    }
    if (
        (before && (before.parentId ?? null) !== (params.parentId ?? null))
        || (after && (after.parentId ?? null) !== (params.parentId ?? null))
        || (before && buildSessionFolderWorkspaceRefKey(before.workspace) !== buildSessionFolderWorkspaceRefKey(target.workspace))
        || (after && buildSessionFolderWorkspaceRefKey(after.workspace) !== buildSessionFolderWorkspaceRefKey(target.workspace))
    ) {
        return { next: params.current, folder: null };
    }
    if (
        (target.parentId ?? null) === (params.parentId ?? null)
        && !params.beforeFolderId
        && !params.afterFolderId
    ) {
        return { next: params.current, folder: target };
    }

    const destinationSiblings = params.current.folders
        .filter((folder) => (
            folder.id !== target.id
            && buildSessionFolderWorkspaceRefKey(folder.workspace) === buildSessionFolderWorkspaceRefKey(target.workspace)
            && (folder.parentId ?? null) === (params.parentId ?? null)
        ));
    let insertIndex = destinationSiblings.length;
    if (before) {
        insertIndex = destinationSiblings.findIndex((folder) => folder.id === before.id);
    } else if (after) {
        const afterIndex = destinationSiblings.findIndex((folder) => folder.id === after.id);
        insertIndex = afterIndex < 0 ? destinationSiblings.length : afterIndex + 1;
    }
    if (insertIndex < 0) insertIndex = destinationSiblings.length;
    const orderedDestinationSiblings = [...destinationSiblings];
    orderedDestinationSiblings.splice(insertIndex, 0, { ...target, parentId: params.parentId });
    const sortKeyByFolderId = new Map(
        orderedDestinationSiblings.map((folder, index) => [folder.id, String(index + 1).padStart(6, '0')] as const),
    );

    const next = normalizeSessionFolders({
        v: 1,
        folders: params.current.folders.map((folder) => folder.id === target.id
            ? {
                ...folder,
                parentId: params.parentId,
                sortKey: sortKeyByFolderId.get(folder.id) ?? folder.sortKey,
                updatedAt: params.now,
            }
            : sortKeyByFolderId.has(folder.id)
                ? { ...folder, sortKey: sortKeyByFolderId.get(folder.id), updatedAt: params.now }
                : folder),
    });
    return {
        next,
        folder: next.folders.find((folder) => folder.id === target.id) ?? null,
    };
}
