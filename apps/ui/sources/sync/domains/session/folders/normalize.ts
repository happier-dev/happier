import { SESSION_FOLDER_MAX_COUNT, SESSION_FOLDER_MAX_DEPTH } from './constants';
import { makeSiblingUniqueSessionFolderName, normalizeSessionFolderName } from './names';
import { migrateLegacyPaddedSortKeysToFractional, rebalanceSortKeys } from './orderKey';
import type { SessionFolderV1, SessionFoldersV1 } from './types';
import { buildSessionFolderWorkspaceRefKey, normalizeSessionFolderWorkspaceRef } from './workspaceRefs';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTimestamp(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parentCreatesCycle(folderId: string, parentId: string | null, byId: ReadonlyMap<string, SessionFolderV1>): boolean {
    let current = parentId;
    const seen = new Set<string>();
    while (current) {
        if (current === folderId) return true;
        if (seen.has(current)) return true;
        seen.add(current);
        current = byId.get(current)?.parentId ?? null;
    }
    return false;
}

function resolveDepth(folder: SessionFolderV1, byId: ReadonlyMap<string, SessionFolderV1>): number {
    let depth = 0;
    let current = folder.parentId;
    const seen = new Set<string>([folder.id]);
    while (current) {
        if (seen.has(current)) return SESSION_FOLDER_MAX_DEPTH + 1;
        seen.add(current);
        const parent = byId.get(current);
        if (!parent) return depth;
        depth += 1;
        current = parent.parentId;
    }
    return depth;
}

export function normalizeSessionFolders(
    value: unknown,
    options: Readonly<{
        currentRenderWorkspaceKeysByFolderId?: Readonly<Record<string, string>>;
    }> = {},
): SessionFoldersV1 {
    if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.folders)) {
        return { v: 1, folders: [] };
    }

    const byId = new Map<string, SessionFolderV1>();
    const ordered: SessionFolderV1[] = [];
    for (const rawFolder of value.folders.slice(0, SESSION_FOLDER_MAX_COUNT)) {
        if (!isRecord(rawFolder)) continue;
        const id = String(rawFolder.id ?? '').trim();
        const workspace = normalizeSessionFolderWorkspaceRef(rawFolder.workspace);
        const name = normalizeSessionFolderName(rawFolder.name);
        if (!id || !workspace || !name || byId.has(id)) continue;

        const folder: SessionFolderV1 = {
            id,
            workspace,
            ...(typeof rawFolder.renderWorkspaceKey === 'string' && rawFolder.renderWorkspaceKey.trim()
                ? { renderWorkspaceKey: rawFolder.renderWorkspaceKey.trim() }
                : {}),
            parentId: typeof rawFolder.parentId === 'string' && rawFolder.parentId.trim()
                ? rawFolder.parentId.trim()
                : null,
            name,
            createdAt: normalizeTimestamp(rawFolder.createdAt, 0),
            updatedAt: normalizeTimestamp(rawFolder.updatedAt, normalizeTimestamp(rawFolder.createdAt, 0)),
            ...(typeof rawFolder.sortKey === 'string' && rawFolder.sortKey.trim()
                ? { sortKey: rawFolder.sortKey.trim() }
                : {}),
        };
        byId.set(id, folder);
        ordered.push(folder);
    }

    const parentNormalized = ordered.map((folder): SessionFolderV1 => {
        const parent = folder.parentId ? byId.get(folder.parentId) : null;
        const parentId = parent
            && buildSessionFolderWorkspaceRefKey(parent.workspace) === buildSessionFolderWorkspaceRefKey(folder.workspace)
            && !parentCreatesCycle(folder.id, parent.id, byId)
            ? parent.id
            : null;
        return { ...folder, parentId };
    });

    const byIdAfterParents = new Map(parentNormalized.map((folder) => [folder.id, folder] as const));
    const nameKeysBySibling = new Map<string, Set<string>>();
    const finalFolders: SessionFolderV1[] = [];
    for (const folder of parentNormalized) {
        const depth = resolveDepth(folder, byIdAfterParents);
        const parentId = depth > SESSION_FOLDER_MAX_DEPTH ? null : folder.parentId;
        const siblingKey = `${buildSessionFolderWorkspaceRefKey(folder.workspace)}:${parentId ?? 'root'}`;
        const siblingNames = nameKeysBySibling.get(siblingKey) ?? new Set<string>();
        nameKeysBySibling.set(siblingKey, siblingNames);
        const name = makeSiblingUniqueSessionFolderName(folder.name, siblingNames);
        siblingNames.add(name.toLocaleLowerCase());
        finalFolders.push({
            ...folder,
            parentId,
            name,
            ...(options.currentRenderWorkspaceKeysByFolderId?.[folder.id]
                ? { renderWorkspaceKey: options.currentRenderWorkspaceKeysByFolderId[folder.id] }
                : {}),
        });
    }

    const migrationSortKeysByFolderId = new Map<string, string>();
    const siblingsByKey = new Map<string, SessionFolderV1[]>();
    for (const folder of finalFolders) {
        const siblingKey = `${buildSessionFolderWorkspaceRefKey(folder.workspace)}:${folder.parentId ?? 'root'}`;
        const siblings = siblingsByKey.get(siblingKey) ?? [];
        siblings.push(folder);
        siblingsByKey.set(siblingKey, siblings);
    }
    for (const siblings of siblingsByKey.values()) {
        const migrated = siblings.every((folder) => !folder.sortKey)
            ? rebalanceSortKeys(new Map(
                siblings.map((folder, index) => [folder.id, String(index + 1).padStart(6, '0')] as const),
            ))
            : migrateLegacyPaddedSortKeysToFractional(siblings);
        for (const [folderId, sortKey] of migrated) {
            migrationSortKeysByFolderId.set(folderId, sortKey);
        }
    }

    return {
        v: 1,
        folders: migrationSortKeysByFolderId.size === 0
            ? finalFolders
            : finalFolders.map((folder) => {
                const sortKey = migrationSortKeysByFolderId.get(folder.id);
                return sortKey ? { ...folder, sortKey } : folder;
            }),
    };
}
