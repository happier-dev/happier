import Fuse from 'fuse.js';

import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { machineFilesystemListDirectory } from '@/sync/ops/machineFileBrowser';
import { machineRipgrep } from '@/sync/ops/machineRipgrep';
import { AsyncLock } from '@/utils/system/lock';

type WorkspaceCache = {
    files: FileSearchItem[];
    fuse: Fuse<FileSearchItem> | null;
    lastRefresh: number;
    refreshLock: AsyncLock;
};

const FILE_INDEX_FALLBACK_LIMIT = 5000;

function normalizeRepoRelativePath(value: string): string {
    return value.trim().replace(/\\/g, '/').replace(/^\.\/+/g, '');
}

function shouldSkipFallbackPath(name: string): boolean {
    return name.startsWith('.') || name === 'node_modules';
}

function escapeRipgrepGlob(input: string): string {
    return input
        .replace(/\\/g, '\\\\')
        .replace(/\*/g, '\\*')
        .replace(/\?/g, '\\?')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

function parseRipgrepFiles(stdout: string | undefined): string[] {
    if (typeof stdout !== 'string') return [];
    return stdout
        .split('\n')
        .map((line) => normalizeRepoRelativePath(line))
        .filter((line) => line.length > 0);
}

function buildFileItemsFromPaths(filePaths: string[]): FileSearchItem[] {
    const files: FileSearchItem[] = [];
    const directories = new Set<string>();

    for (const rawPath of filePaths) {
        const fullPath = normalizeRepoRelativePath(rawPath);
        if (!fullPath) continue;
        const parts = fullPath.split('/').filter(Boolean);
        if (parts.length === 0) continue;

        const fileName = parts[parts.length - 1] ?? fullPath;
        const parentPath = parts.slice(0, -1).join('/');
        files.push({
            fileName,
            filePath: parentPath ? `${parentPath}/` : '',
            fullPath,
            fileType: 'file',
        });

        for (let i = 1; i <= parts.length - 1; i++) {
            const dirPath = parts.slice(0, i).join('/');
            if (dirPath) directories.add(dirPath);
        }
    }

    for (const dirPath of directories) {
        const parts = dirPath.split('/').filter(Boolean);
        if (parts.length === 0) continue;
        const dirName = parts[parts.length - 1] ?? dirPath;
        const parentPath = parts.slice(0, -1).join('/');
        files.push({
            fileName: `${dirName}/`,
            filePath: parentPath ? `${parentPath}/` : '',
            fullPath: `${dirPath}/`,
            fileType: 'folder',
        });
    }

    return files;
}

function createFuse(files: FileSearchItem[], threshold: number = 0.3): Fuse<FileSearchItem> {
    return new Fuse(files, {
        keys: [
            { name: 'fileName', weight: 0.7 },
            { name: 'fullPath', weight: 0.3 },
        ],
        includeScore: true,
        threshold,
        shouldSort: true,
        ignoreLocation: true,
        distance: 100,
    });
}

const workspaceCaches = new Map<string, WorkspaceCache>();

function getOrCreateWorkspaceCache(workspaceCacheKey: string): WorkspaceCache {
    const existing = workspaceCaches.get(workspaceCacheKey);
    if (existing) return existing;
    const created: WorkspaceCache = {
        files: [],
        fuse: null,
        lastRefresh: 0,
        refreshLock: new AsyncLock(),
    };
    workspaceCaches.set(workspaceCacheKey, created);
    return created;
}

async function buildFileItemsFromRipgrep(machineId: string, rootPath: string): Promise<FileSearchItem[] | null> {
    const res = await machineRipgrep(machineId, ['--files', '--follow'], rootPath);
    if (!res.success) return null;
    const paths = parseRipgrepFiles(res.stdout);
    return buildFileItemsFromPaths(paths);
}

async function buildFileItemsFromRipgrepGlob(
    machineId: string,
    rootPath: string,
    query: string,
    limit: number,
): Promise<FileSearchItem[] | null> {
    const trimmed = query.trim();
    if (!trimmed) return null;

    const needle = escapeRipgrepGlob(trimmed).replace(/\s+/g, '*');
    const pattern = `*${needle}*`;

    const res = await machineRipgrep(machineId, ['--files', '--follow', '--hidden', '--iglob', pattern], rootPath);
    if (!res.success) return null;
    const paths = parseRipgrepFiles(res.stdout).slice(0, Math.max(50, limit * 5));
    if (paths.length === 0) return null;
    return buildFileItemsFromPaths(paths);
}

function joinPathAbsolute(rootPath: string, directoryPath: string): string {
    const root = rootPath.trim().replace(/\/+$/g, '');
    const rel = directoryPath.trim().replace(/^\/+/g, '');
    if (!root) return rel;
    if (!rel) return root;
    return `${root}/${rel}`;
}

async function buildFileItemsFromDirectoryFallback(input: Readonly<{
    machineId: string;
    rootPath: string;
    serverId?: string | null;
}>): Promise<FileSearchItem[] | null> {
    const files: FileSearchItem[] = [];
    const queue: string[] = [''];
    const visited = new Set<string>(['']);

    while (queue.length > 0 && files.length < FILE_INDEX_FALLBACK_LIMIT) {
        const directoryPath = queue.shift() ?? '';
        const absPath = joinPathAbsolute(input.rootPath, directoryPath);
        const response = await machineFilesystemListDirectory(
            input.machineId,
            { path: absPath, includeFiles: true },
            { serverId: input.serverId },
        );
        if (!response.ok || !Array.isArray(response.entries)) {
            continue;
        }

        for (const entry of response.entries) {
            if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
            if (shouldSkipFallbackPath(entry.name)) continue;

            const prefix = directoryPath ? `${directoryPath}/` : '';
            const filePath = directoryPath ? `${directoryPath}/` : '';

            if (entry.type === 'directory') {
                const nestedDirectory = `${prefix}${entry.name}`;
                files.push({
                    fileName: `${entry.name}/`,
                    filePath,
                    fullPath: `${nestedDirectory}/`,
                    fileType: 'folder',
                });

                if (!visited.has(nestedDirectory) && files.length < FILE_INDEX_FALLBACK_LIMIT) {
                    visited.add(nestedDirectory);
                    queue.push(nestedDirectory);
                }
                continue;
            }

            if (entry.type === 'file') {
                files.push({
                    fileName: entry.name,
                    filePath,
                    fullPath: `${prefix}${entry.name}`,
                    fileType: 'file',
                });
            }

            if (files.length >= FILE_INDEX_FALLBACK_LIMIT) {
                break;
            }
        }
    }

    if (files.length === 0) return null;
    return files;
}

async function ensureCacheValid(input: Readonly<{
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId?: string | null;
}>): Promise<void> {
    const cache = getOrCreateWorkspaceCache(input.workspaceCacheKey);
    const now = Date.now();

    // Cache is invalidated explicitly by SCM snapshot updates and user refresh actions.
    if (cache.files.length > 0) {
        return;
    }

    await cache.refreshLock.inLock(async () => {
        const nowInner = Date.now();
        // Skip refresh if we re-indexed very recently; avoids hammering ripgrep on each keystroke.
        if (nowInner - cache.lastRefresh < 1000) return;

        let files: FileSearchItem[] | null = null;
        try {
            files = await buildFileItemsFromRipgrep(input.machineId, input.rootPath);
        } catch {
            files = null;
        }

        if (!files) {
            files = await buildFileItemsFromDirectoryFallback({
                machineId: input.machineId,
                rootPath: input.rootPath,
                serverId: input.serverId,
            });
        }
        if (!files || files.length === 0) return;

        cache.files = files;
        cache.lastRefresh = now;
        cache.fuse = createFuse(files);
    });
}

export const workspaceFileSearchCache = {
    clearCache(workspaceCacheKey?: string) {
        const normalized = typeof workspaceCacheKey === 'string' ? workspaceCacheKey.trim() : '';
        if (normalized) {
            workspaceCaches.delete(normalized);
            return;
        }
        workspaceCaches.clear();
    },
};

export async function searchWorkspaceFiles(input: Readonly<{
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId?: string | null;
    query: string;
    limit?: number;
    threshold?: number;
}>): Promise<FileSearchItem[]> {
    const workspaceCacheKey = String(input.workspaceCacheKey ?? '').trim();
    if (!workspaceCacheKey) return [];

    await ensureCacheValid({
        workspaceCacheKey,
        machineId: input.machineId,
        rootPath: input.rootPath,
        serverId: input.serverId,
    });

    const cache = getOrCreateWorkspaceCache(workspaceCacheKey);
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(1000, Math.floor(input.limit)))
        : 10;

    if (!cache.fuse || cache.files.length === 0) return [];

    const query = String(input.query ?? '').trim();
    if (!query) {
        return cache.files.slice(0, limit);
    }

    const threshold = typeof input.threshold === 'number' && Number.isFinite(input.threshold)
        ? Math.max(0, Math.min(1, input.threshold))
        : 0.3;

    const fuse = threshold === 0.3 ? cache.fuse : createFuse(cache.files, threshold);
    const results = fuse.search(query, { limit });
    if (results.length > 0) {
        return results.map((r) => r.item);
    }

    const globItems = await buildFileItemsFromRipgrepGlob(input.machineId, input.rootPath, query, limit);
    if (!globItems || globItems.length === 0) return [];

    const known = new Set(cache.files.map((f) => f.fullPath));
    let changed = false;
    for (const item of globItems) {
        if (!known.has(item.fullPath)) {
            known.add(item.fullPath);
            cache.files.push(item);
            changed = true;
        }
    }
    if (changed) {
        cache.fuse = createFuse(cache.files);
    }

    return globItems.slice(0, limit);
}
