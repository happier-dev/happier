import Fuse from 'fuse.js';

import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
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

function createWorkspaceFileSearchAbortError(): Error {
    const error = new Error('Workspace file search was aborted');
    error.name = 'AbortError';
    Object.assign(error, { code: 'WORKSPACE_FILE_SEARCH_ABORTED' });
    return error;
}

function throwIfWorkspaceFileSearchAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw createWorkspaceFileSearchAbortError();
    }
}

function awaitWorkspaceFileSearchWork<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(createWorkspaceFileSearchAbortError());

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (apply: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            apply();
        };
        function onAbort() {
            finish(() => reject(createWorkspaceFileSearchAbortError()));
        }

        signal.addEventListener('abort', onAbort, { once: true });
        work.then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error)),
        );
    });
}

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

/**
 * The address every read in this module is issued against — and, via
 * `tryBuildWorkspaceCacheKey`, the identity every cache entry is filed under. It is one
 * argument on purpose.
 *
 * A machine id is only unique within the server that reaches it, so all three parts travel
 * together. When the key and the address were separate parameters, they disagreed twice in
 * one day: the ripgrep reads dropped `serverId` while the directory fallback kept it, and a
 * live caller passed a server-scoped key while routing without the server — building one
 * server's index and filing it under another server's key. Deriving both from a single
 * `WorkspaceScopeBase` is what makes that unsayable rather than merely unsaid.
 *
 * The key is derived through `tryBuildWorkspaceCacheKey`, which normalizes. The READ address
 * stays the caller's raw scope: `normalizeFileSystemPath` lowercases Windows drive and UNC
 * paths, and ripgrep's `cwd` must keep the caller's spelling.
 */
async function buildFileItemsFromRipgrep(
    address: WorkspaceScopeBase,
    signal: AbortSignal | undefined,
): Promise<FileSearchItem[] | null> {
    throwIfWorkspaceFileSearchAborted(signal);
    const res = await machineRipgrep(
        address.machineId,
        ['--files', '--follow'],
        address.rootPath,
        {
            serverId: address.serverId,
            ...(signal ? { signal } : {}),
        },
    );
    throwIfWorkspaceFileSearchAborted(signal);
    if (!res.success) return null;
    const paths = parseRipgrepFiles(res.stdout);
    return buildFileItemsFromPaths(paths);
}

async function buildFileItemsFromRipgrepGlob(
    address: WorkspaceScopeBase,
    query: string,
    limit: number,
    signal: AbortSignal | undefined,
): Promise<FileSearchItem[] | null> {
    throwIfWorkspaceFileSearchAborted(signal);
    const trimmed = query.trim();
    if (!trimmed) return null;

    const needle = escapeRipgrepGlob(trimmed).replace(/\s+/g, '*');
    const pattern = `*${needle}*`;

    const res = await machineRipgrep(
        address.machineId,
        ['--files', '--follow', '--hidden', '--iglob', pattern],
        address.rootPath,
        {
            serverId: address.serverId,
            ...(signal ? { signal } : {}),
        },
    );
    throwIfWorkspaceFileSearchAborted(signal);
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

async function buildFileItemsFromDirectoryFallback(
    input: WorkspaceScopeBase,
    signal: AbortSignal | undefined,
): Promise<FileSearchItem[] | null> {
    const files: FileSearchItem[] = [];
    const queue: string[] = [''];
    const visited = new Set<string>(['']);

    while (queue.length > 0 && files.length < FILE_INDEX_FALLBACK_LIMIT) {
        throwIfWorkspaceFileSearchAborted(signal);
        const directoryPath = queue.shift() ?? '';
        const absPath = joinPathAbsolute(input.rootPath, directoryPath);
        const response = await machineFilesystemListDirectory(
            input.machineId,
            { path: absPath, includeFiles: true },
            {
                serverId: input.serverId,
                ...(signal ? { signal } : {}),
            },
        );
        throwIfWorkspaceFileSearchAborted(signal);
        if (!response.ok || !Array.isArray(response.entries)) {
            continue;
        }

        for (const entry of response.entries) {
            throwIfWorkspaceFileSearchAborted(signal);
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
    scope: WorkspaceScopeBase;
    workspaceCacheKey: string;
    signal?: AbortSignal;
}>): Promise<void> {
    const cache = getOrCreateWorkspaceCache(input.workspaceCacheKey);
    const now = Date.now();
    throwIfWorkspaceFileSearchAborted(input.signal);

    // Cache is invalidated explicitly by SCM snapshot updates and user refresh actions.
    if (cache.files.length > 0) {
        return;
    }

    const refresh = cache.refreshLock.inLock(async () => {
        throwIfWorkspaceFileSearchAborted(input.signal);
        const nowInner = Date.now();
        // Skip refresh if we re-indexed very recently; avoids hammering ripgrep on each keystroke.
        if (nowInner - cache.lastRefresh < 1000) return;

        const address = input.scope;

        let files: FileSearchItem[] | null = null;
        try {
            files = await buildFileItemsFromRipgrep(address, input.signal);
        } catch (error) {
            if (input.signal?.aborted) throw error;
            files = null;
        }

        throwIfWorkspaceFileSearchAborted(input.signal);
        if (!files) {
            files = await buildFileItemsFromDirectoryFallback(address, input.signal);
        }
        throwIfWorkspaceFileSearchAborted(input.signal);
        if (!files || files.length === 0) return;

        cache.files = files;
        cache.lastRefresh = now;
        cache.fuse = createFuse(files);
    });
    await awaitWorkspaceFileSearchWork(refresh, input.signal);
}

export const workspaceFileSearchCache = {
    /**
     * Drops one workspace's index, addressed by the same scope that fills it — so a clear
     * cannot silently miss the entry a search wrote by spelling the key differently.
     *
     * Clearing "everything" is a separate, explicitly named operation. A single optional
     * parameter meaning *either* "one workspace" *or* "all workspaces" turns a scope that
     * failed to resolve into a silent full cache wipe.
     */
    clearCache(scope: WorkspaceScopeBase) {
        const workspaceCacheKey = tryBuildWorkspaceCacheKey(scope);
        if (!workspaceCacheKey) return;
        workspaceCaches.delete(workspaceCacheKey);
    },

    clearAll() {
        workspaceCaches.clear();
    },
};

/**
 * Searches one workspace's file index.
 *
 * There is deliberately **no `workspaceCacheKey` parameter**: the key is derived here, from
 * the same `scope` the reads are routed with, so a caller cannot key by one workspace and
 * read through another. See the note above `buildFileItemsFromRipgrep` for the two defects
 * that shape came from.
 */
export async function searchWorkspaceFiles(input: Readonly<{
    scope: WorkspaceScopeBase;
    query: string;
    limit?: number;
    threshold?: number;
    signal?: AbortSignal;
}>): Promise<FileSearchItem[]> {
    throwIfWorkspaceFileSearchAborted(input.signal);
    // Fails closed on a scope that names no workspace, exactly as the empty-key guard this
    // replaces did — an unaddressable workspace has no index to search.
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(input.scope);
    if (!workspaceCacheKey) return [];

    await ensureCacheValid({
        scope: input.scope,
        workspaceCacheKey,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfWorkspaceFileSearchAborted(input.signal);

    const cache = getOrCreateWorkspaceCache(workspaceCacheKey);
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(1000, Math.floor(input.limit)))
        : 10;

    if (!cache.fuse || cache.files.length === 0) return [];

    const query = String(input.query ?? '').trim();
    if (!query) {
        throwIfWorkspaceFileSearchAborted(input.signal);
        return cache.files.slice(0, limit);
    }

    const threshold = typeof input.threshold === 'number' && Number.isFinite(input.threshold)
        ? Math.max(0, Math.min(1, input.threshold))
        : 0.3;

    const fuse = threshold === 0.3 ? cache.fuse : createFuse(cache.files, threshold);
    const results = fuse.search(query, { limit });
    if (results.length > 0) {
        throwIfWorkspaceFileSearchAborted(input.signal);
        return results.map((r) => r.item);
    }

    const globItems = await buildFileItemsFromRipgrepGlob(input.scope, query, limit, input.signal);
    throwIfWorkspaceFileSearchAborted(input.signal);
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

    throwIfWorkspaceFileSearchAborted(input.signal);
    return globItems.slice(0, limit);
}
