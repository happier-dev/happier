import Fuse from 'fuse.js';
import { WORKSPACE_FILE_LIST_MAX_RESULTS, type DaemonWorkspaceFileListErrorCode } from '@happier-dev/protocol/machines/workspaceFiles';

import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import {
    captureActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { machineFilesystemListDirectory } from '@/sync/ops/machineFileBrowser';
import { machineWorkspaceFileList } from '@/sync/ops/machineWorkspaceFileList';
import { AsyncLock } from '@/utils/system/lock';

type WorkspaceCache = {
    files: FileSearchItem[];
    fuse: Fuse<FileSearchItem> | null;
    fileFuse: Fuse<FileSearchItem> | null;
    truncated: boolean;
    initialized: boolean;
    lastRefresh: number;
    refreshLock: AsyncLock;
};

type WorkspaceCachePartition = {
    caches: Map<string, WorkspaceCache>;
    retirement: Readonly<{ dispose(): void }> | null;
};

export type WorkspaceFileSearchAccountLifetime = Readonly<{
    accountId?: string;
    scope?: Readonly<{ accountId: string }>;
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

export class WorkspaceFileSearchUnavailableError extends Error {
    readonly code = 'WORKSPACE_FILE_SEARCH_UNAVAILABLE';

    constructor(readonly errorCode?: DaemonWorkspaceFileListErrorCode) {
        super('Workspace file search is unavailable');
        this.name = 'WorkspaceFileSearchUnavailableError';
    }
}

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
    return name === '.git' || name === 'node_modules';
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

// Keep fuzzy score ordering within each relevance tier. Test/spec variants are
// basename prefixes, after the exact stem, and before broader fuzzy matches.
function fileSearchRelevance(file: FileSearchItem, query: string): number {
    const needle = query.trim().toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
    const name = file.fileName.toLowerCase().replace(/\/$/, '');
    const path = file.fullPath.toLowerCase().replace(/\/$/, '');
    if (path === needle || name === needle) return 0;
    if (!needle.includes('/') && !needle.includes('.') && file.fileType === 'file') {
        const extension = name.lastIndexOf('.');
        if (extension > 0 && name.slice(0, extension) === needle) return 1;
    }
    if (!needle.includes('/') && name.startsWith(`${needle}.`)) return 2;
    if ((needle.includes('/') ? path : name).startsWith(needle)) return 3;
    return 4;
}

function rankFileSearchResults(files: FileSearchItem[], query: string): FileSearchItem[] {
    return files.sort((a, b) => fileSearchRelevance(a, query) - fileSearchRelevance(b, query));
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

const workspaceCachePartitions = new Map<WorkspaceFileSearchAccountLifetime | null, WorkspaceCachePartition>();

function resolveWorkspaceFileSearchAccountLifetime(
    explicitLifetime?: WorkspaceFileSearchAccountLifetime,
): WorkspaceFileSearchAccountLifetime | null {
    const lifetime = explicitLifetime ?? captureActiveServerAccountScopeLifetime();
    return lifetime;
}

function throwIfWorkspaceFileSearchAccountRetired(lifetime: WorkspaceFileSearchAccountLifetime | null): void {
    if (lifetime && !lifetime.isCurrent()) {
        throw new WorkspaceFileSearchUnavailableError();
    }
}

function readWorkspaceFileSearchAccountId(
    lifetime: WorkspaceFileSearchAccountLifetime | null,
): string | null {
    const accountId = String(lifetime?.accountId ?? lifetime?.scope?.accountId ?? '').trim();
    return accountId || null;
}

function getOrCreateWorkspaceCachePartition(
    lifetime: WorkspaceFileSearchAccountLifetime | null,
): WorkspaceCachePartition {
    const existing = workspaceCachePartitions.get(lifetime);
    if (existing) return existing;

    const created: WorkspaceCachePartition = {
        caches: new Map(),
        retirement: null,
    };
    workspaceCachePartitions.set(lifetime, created);
    if (lifetime) {
        created.retirement = lifetime.onRetire(() => {
            created.caches.clear();
            if (workspaceCachePartitions.get(lifetime) === created) {
                workspaceCachePartitions.delete(lifetime);
            }
            created.retirement = null;
        });
    }
    return created;
}

function getOrCreateWorkspaceCache(
    partition: WorkspaceCachePartition,
    workspaceCacheKey: string,
): WorkspaceCache {
    const existing = partition.caches.get(workspaceCacheKey);
    if (existing) return existing;
    const created: WorkspaceCache = {
        files: [],
        fuse: null,
        fileFuse: null,
        truncated: false,
        initialized: false,
        lastRefresh: 0,
        refreshLock: new AsyncLock(),
    };
    partition.caches.set(workspaceCacheKey, created);
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
    accountId: string | null,
    signal: AbortSignal | undefined,
): Promise<Readonly<{ files: FileSearchItem[]; truncated: boolean }> | null> {
    throwIfWorkspaceFileSearchAborted(signal);
    const res = await machineWorkspaceFileList(
        address.machineId,
        { rootPath: address.rootPath, includeHidden: true, limit: WORKSPACE_FILE_LIST_MAX_RESULTS },
        {
            serverId: address.serverId,
            ...(accountId ? { accountId } : {}),
            ...(signal ? { signal } : {}),
        },
    );
    throwIfWorkspaceFileSearchAborted(signal);
    if (!res.ok) return null;
    return { files: buildFileItemsFromPaths(res.paths), truncated: res.truncated };
}

async function buildFileItemsFromRipgrepGlob(
    address: WorkspaceScopeBase,
    accountId: string | null,
    query: string,
    limit: number,
    signal: AbortSignal | undefined,
): Promise<Readonly<{ files: FileSearchItem[]; truncated: boolean }> | null> {
    throwIfWorkspaceFileSearchAborted(signal);
    const trimmed = query.trim();
    if (!trimmed) return null;

    const resultLimit = Math.min(WORKSPACE_FILE_LIST_MAX_RESULTS, Math.max(50, limit * 5));
    const res = await machineWorkspaceFileList(
        address.machineId,
        { rootPath: address.rootPath, query: trimmed, includeHidden: true, limit: resultLimit },
        {
            serverId: address.serverId,
            ...(accountId ? { accountId } : {}),
            ...(signal ? { signal } : {}),
        },
    );
    throwIfWorkspaceFileSearchAborted(signal);
    if (!res.ok) throw new WorkspaceFileSearchUnavailableError(res.errorCode);
    return { files: buildFileItemsFromPaths(res.paths), truncated: res.truncated };
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
    accountId: string | null,
    signal: AbortSignal | undefined,
): Promise<Readonly<{ files: FileSearchItem[]; truncated: boolean }> | null> {
    const files: FileSearchItem[] = [];
    const queue: string[] = [''];
    const visited = new Set<string>(['']);
    let answered = false;
    let truncated = false;

    while (queue.length > 0 && files.length < WORKSPACE_FILE_LIST_MAX_RESULTS) {
        throwIfWorkspaceFileSearchAborted(signal);
        const directoryPath = queue.shift() ?? '';
        const absPath = joinPathAbsolute(input.rootPath, directoryPath);
        let response: Awaited<ReturnType<typeof machineFilesystemListDirectory>> | undefined;
        try {
            response = await machineFilesystemListDirectory(
                input.machineId,
                { path: absPath, includeFiles: true },
                {
                    serverId: input.serverId,
                    ...(accountId ? { accountId } : {}),
                    ...(signal ? { signal } : {}),
                },
            );
        } catch (error) {
            if (signal?.aborted) throw error;
            continue;
        }
        throwIfWorkspaceFileSearchAborted(signal);
        if (!response.ok || !Array.isArray(response.entries)) {
            continue;
        }
        answered = true;

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

                if (!visited.has(nestedDirectory) && files.length < WORKSPACE_FILE_LIST_MAX_RESULTS) {
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

            if (files.length >= WORKSPACE_FILE_LIST_MAX_RESULTS) {
                truncated = true;
                break;
            }
        }
    }

    return answered ? { files, truncated: truncated || queue.length > 0 } : null;
}

async function ensureCacheValid(input: Readonly<{
    scope: WorkspaceScopeBase;
    partition: WorkspaceCachePartition;
    workspaceCacheKey: string;
    accountLifetime: WorkspaceFileSearchAccountLifetime | null;
    signal?: AbortSignal;
}>): Promise<void> {
    const cache = getOrCreateWorkspaceCache(input.partition, input.workspaceCacheKey);
    const now = Date.now();
    throwIfWorkspaceFileSearchAborted(input.signal);
    throwIfWorkspaceFileSearchAccountRetired(input.accountLifetime);

    // Cache is invalidated explicitly by SCM snapshot updates and user refresh actions.
    if (cache.initialized) {
        return;
    }

    const refresh = cache.refreshLock.inLock(async () => {
        throwIfWorkspaceFileSearchAborted(input.signal);
        throwIfWorkspaceFileSearchAccountRetired(input.accountLifetime);
        const nowInner = Date.now();
        // Skip refresh if we re-indexed very recently; avoids hammering ripgrep on each keystroke.
        if (nowInner - cache.lastRefresh < 1000) return;

        const address = input.scope;

        let result: Readonly<{ files: FileSearchItem[]; truncated: boolean }> | null = null;
        try {
            result = await buildFileItemsFromRipgrep(
                address,
                readWorkspaceFileSearchAccountId(input.accountLifetime),
                input.signal,
            );
        } catch (error) {
            if (input.signal?.aborted) throw error;
            result = null;
        }

        throwIfWorkspaceFileSearchAborted(input.signal);
        if (!result) {
            result = await buildFileItemsFromDirectoryFallback(
                address,
                readWorkspaceFileSearchAccountId(input.accountLifetime),
                input.signal,
            );
        }
        throwIfWorkspaceFileSearchAborted(input.signal);
        throwIfWorkspaceFileSearchAccountRetired(input.accountLifetime);
        if (!result) throw new WorkspaceFileSearchUnavailableError();

        cache.files = result.files;
        cache.truncated = result.truncated;
        cache.initialized = true;
        cache.lastRefresh = now;
        cache.fuse = result.files.length > 0 ? createFuse(result.files) : null;
        const onlyFiles = result.files.filter((item) => item.fileType === 'file');
        cache.fileFuse = onlyFiles.length > 0 ? createFuse(onlyFiles) : null;
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
        for (const partition of workspaceCachePartitions.values()) {
            partition.caches.delete(workspaceCacheKey);
        }
    },

    clearAll() {
        for (const partition of workspaceCachePartitions.values()) {
            partition.caches.clear();
        }
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
export type WorkspaceFileSearchPage = Readonly<{
    items: readonly FileSearchItem[];
    /** The source corpus is incomplete, independently of the visible page size. */
    corpusTruncated: boolean;
    /** Additional matches are known, or the source could contain more matching paths. */
    hasMore: boolean;
}>;

export type WorkspaceFileSearchInput = Readonly<{
    scope: WorkspaceScopeBase;
    query: string;
    limit?: number;
    threshold?: number;
    resultType?: FileSearchItem['fileType'];
    /** Exact selected-Home credential lifetime; omitted callers retain the active Account owner. */
    accountLifetime?: WorkspaceFileSearchAccountLifetime;
    signal?: AbortSignal;
    includeCoverage?: boolean;
    /** Arbitrary directory browsers query the daemon glob directly, without a workspace index. */
    mode?: 'fuzzy' | 'glob';
    includeHidden?: boolean;
}>;

export function searchWorkspaceFiles(
    input: WorkspaceFileSearchInput & Readonly<{ includeCoverage: true }>,
): Promise<WorkspaceFileSearchPage>;
export function searchWorkspaceFiles(input: WorkspaceFileSearchInput): Promise<FileSearchItem[]>;
export async function searchWorkspaceFiles(
    input: WorkspaceFileSearchInput,
): Promise<FileSearchItem[] | WorkspaceFileSearchPage> {
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(1000, Math.floor(input.limit)))
        : input.mode === 'glob' ? Infinity : 10;
    const project = (items: readonly FileSearchItem[], corpusTruncated: boolean) => {
        const page = items.slice(0, limit);
        return input.includeCoverage === true
            ? Object.freeze({ items: Object.freeze(page), corpusTruncated, hasMore: corpusTruncated || items.length > limit })
            : page;
    };
    throwIfWorkspaceFileSearchAborted(input.signal);
    const accountLifetime = resolveWorkspaceFileSearchAccountLifetime(input.accountLifetime);
    throwIfWorkspaceFileSearchAccountRetired(accountLifetime);
    if (input.mode === 'glob') {
        const response = await machineWorkspaceFileList(input.scope.machineId, {
            rootPath: input.scope.rootPath,
            query: input.query.trim(),
            includeHidden: input.includeHidden ?? true,
            ...(input.limit === undefined ? {} : { limit: Math.min(WORKSPACE_FILE_LIST_MAX_RESULTS, Math.max(1, Math.floor(input.limit))) }),
        }, {
            serverId: input.scope.serverId,
            ...(readWorkspaceFileSearchAccountId(accountLifetime) ? { accountId: readWorkspaceFileSearchAccountId(accountLifetime) } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        throwIfWorkspaceFileSearchAborted(input.signal);
        throwIfWorkspaceFileSearchAccountRetired(accountLifetime);
        if (!response.ok) throw new WorkspaceFileSearchUnavailableError(response.errorCode);
        const items = buildFileItemsFromPaths(response.paths);
        return project(input.resultType ? items.filter((item) => item.fileType === input.resultType) : items, response.truncated);
    }
    const partition = getOrCreateWorkspaceCachePartition(accountLifetime);
    // Fails closed on a scope that names no workspace, exactly as the empty-key guard this
    // replaces did — an unaddressable workspace has no index to search.
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(input.scope);
    if (!workspaceCacheKey) return project([], false);

    await ensureCacheValid({
        scope: input.scope,
        partition,
        workspaceCacheKey,
        accountLifetime,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfWorkspaceFileSearchAborted(input.signal);
    throwIfWorkspaceFileSearchAccountRetired(accountLifetime);

    const cache = getOrCreateWorkspaceCache(partition, workspaceCacheKey);

    if ((!cache.fuse || cache.files.length === 0) && !cache.truncated) {
        return project([], false);
    }
    const searchableFiles = input.resultType
        ? cache.files.filter((item) => item.fileType === input.resultType)
        : cache.files;
    if (searchableFiles.length === 0 && !cache.truncated) return project([], false);

    const query = String(input.query ?? '').trim();
    if (!query) {
        throwIfWorkspaceFileSearchAborted(input.signal);
        return project(searchableFiles, cache.truncated);
    }

    const threshold = typeof input.threshold === 'number' && Number.isFinite(input.threshold)
        ? Math.max(0, Math.min(1, input.threshold))
        : 0.3;

    const fuse = input.resultType === 'file' && threshold === 0.3
        ? cache.fileFuse
        : input.resultType
        ? createFuse(searchableFiles, threshold)
        : threshold === 0.3 ? cache.fuse : createFuse(cache.files, threshold);
    const cachedResults = fuse?.search(query) ?? [];
    if (cachedResults.length > 0 && !cache.truncated) {
        throwIfWorkspaceFileSearchAborted(input.signal);
        return project(rankFileSearchResults(cachedResults.map((r) => r.item), query), false);
    }

    const globResult = await buildFileItemsFromRipgrepGlob(
        input.scope,
        readWorkspaceFileSearchAccountId(accountLifetime),
        query,
        limit,
        input.signal,
    );
    throwIfWorkspaceFileSearchAborted(input.signal);
    throwIfWorkspaceFileSearchAccountRetired(accountLifetime);
    if (!globResult) {
        return project(rankFileSearchResults(cachedResults.map((result) => result.item), query), cache.truncated);
    }

    const known = new Set(cache.files.map((f) => f.fullPath));
    let changed = false;
    for (const item of globResult.files) {
        if (!known.has(item.fullPath)) {
            known.add(item.fullPath);
            cache.files.push(item);
            changed = true;
        }
    }
    if (changed) {
        throwIfWorkspaceFileSearchAccountRetired(accountLifetime);
        cache.fuse = createFuse(cache.files);
        const onlyFiles = cache.files.filter((item) => item.fileType === 'file');
        cache.fileFuse = onlyFiles.length > 0 ? createFuse(onlyFiles) : null;
    }
    // A targeted query can discover that the canonical workspace corpus is still
    // incomplete. Retain that fact on the lifetime-scoped cache so an identical
    // subsequent query cannot incorrectly treat the cache as complete and skip
    // the bounded query operation.
    cache.truncated = cache.truncated || globResult.truncated;

    throwIfWorkspaceFileSearchAborted(input.signal);
    const mergedSearchable = input.resultType
        ? cache.files.filter((item) => item.fileType === input.resultType)
        : cache.files;
    const mergedFuse = createFuse(mergedSearchable, threshold);
    const merged = rankFileSearchResults(mergedFuse.search(query).map((result) => result.item), query);
    return project(merged, cache.truncated || globResult.truncated);
}
