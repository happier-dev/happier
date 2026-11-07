import type { FilesystemEffectFailureDetailsV1 } from '@happier-dev/protocol/actions/filesystemActionFamily';

import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { machineFilesystemListDirectory } from '@/sync/ops/machineFileBrowser';
import { machineWorkspaceFileList, type MachineWorkspaceFileListErrorCode } from '@/sync/ops/machineWorkspaceFileList';
import { createWorkspaceFileSearchIndex, rankFileSearchResults, type WorkspaceFileSearchIndex } from './workspaceFileSearchMatcher';
import { subscribeWorkspaceRepositoryDirectoryRevision } from './workspaceRepositoryDirectoryRevision';

type WorkspaceCache = {
    files: FileSearchItem[];
    onlyFiles: FileSearchItem[];
    onlyFolders: FileSearchItem[];
    paths: Set<string>;
    filePaths: Set<string>;
    index: WorkspaceFileSearchIndex | null;
    fileIndex: WorkspaceFileSearchIndex | null;
    localIndex: Readonly<{
        recent: readonly FileSearchItem[];
        changed: readonly Readonly<{ fullPath: string; fileName: string; filePath: string }>[];
        index: WorkspaceLocalFileIndex;
    }> | null;
    truncated: boolean;
    initialized: boolean;
    refresh: Promise<void> | null;
    signal: AbortSignal;
    dispose(): void;
};

export type WorkspaceLocalFileIndex = Readonly<{
    files: readonly FileSearchItem[];
    byPath: ReadonlyMap<string, FileSearchItem>;
    search(query: string): FileSearchItem[];
}>;

type WorkspaceCachePartition = {
    caches: Map<string, WorkspaceCache>;
    retirement: Readonly<{ dispose(): void }> | null;
};

export type WorkspaceFileSearchAccountLifetime = Readonly<{
    accountId?: string;
    scope?: Readonly<{ accountId: string; serverId?: string }>;
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

export class WorkspaceFileSearchUnavailableError extends Error {
    readonly code = 'WORKSPACE_FILE_SEARCH_UNAVAILABLE';

    constructor(readonly errorCode?: MachineWorkspaceFileListErrorCode, readonly details?: FilesystemEffectFailureDetailsV1) {
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
    return value.replace(/\\/g, '/').replace(/^\.\/+/g, '');
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

const workspaceCachePartitions = new Map<WorkspaceFileSearchAccountLifetime | null, WorkspaceCachePartition>();

async function resolveWorkspaceFileSearchAccountLifetime(
    serverId: string,
    explicitLifetime?: WorkspaceFileSearchAccountLifetime,
): Promise<WorkspaceFileSearchAccountLifetime> {
    if (explicitLifetime) return explicitLifetime;
    // Subscribe before credential resolution so replacement during the read
    // cannot bind a stale Account. The existing cache partition owns retirement.
    const controller = new AbortController();
    const unsubscribe = subscribeHomeCredentialChange((event) => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) controller.abort();
    });
    try {
        const resolution = await resolveServerCredentialAccountScope(serverId);
        if (controller.signal.aborted || resolution.kind !== 'bound') throw new WorkspaceFileSearchUnavailableError();
        if (resolution.lifetime) { unsubscribe(); return resolution.lifetime; }
        for (const lifetime of workspaceCachePartitions.keys()) {
            if (lifetime?.scope?.serverId === resolution.scope.serverId
                && lifetime.scope.accountId === resolution.scope.accountId && lifetime.isCurrent()) {
                unsubscribe();
                return lifetime;
            }
        }
        const lifetime: WorkspaceFileSearchAccountLifetime = {
            scope: resolution.scope,
            isCurrent: () => !controller.signal.aborted,
            onRetire: (cancel) => {
                if (controller.signal.aborted) { cancel(); return { dispose() {} }; }
                controller.signal.addEventListener('abort', cancel, { once: true });
                return { dispose: () => controller.signal.removeEventListener('abort', cancel) };
            },
        };
        controller.signal.addEventListener('abort', unsubscribe, { once: true });
        getOrCreateWorkspaceCachePartition(lifetime);
        return lifetime;
    } catch (error) {
        unsubscribe();
        throw error;
    }
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
            clearWorkspaceCachePartition(created);
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
    const controller = new AbortController();
    // SCM's pushed revision owns inventory invalidation, including a build in flight.
    const unsubscribeRevision = subscribeWorkspaceRepositoryDirectoryRevision(workspaceCacheKey, () => {
        clearWorkspaceCache(partition, workspaceCacheKey);
    });
    const created: WorkspaceCache = {
        files: [],
        onlyFiles: [],
        onlyFolders: [],
        paths: new Set(),
        filePaths: new Set(),
        index: null,
        fileIndex: null,
        localIndex: null,
        truncated: false,
        initialized: false,
        refresh: null,
        signal: controller.signal,
        dispose() {
            unsubscribeRevision();
            controller.abort();
        },
    };
    partition.caches.set(workspaceCacheKey, created);
    return created;
}

function clearWorkspaceCache(partition: WorkspaceCachePartition, workspaceCacheKey: string): void {
    const cache = partition.caches.get(workspaceCacheKey);
    if (!cache) return;
    partition.caches.delete(workspaceCacheKey);
    cache.dispose();
}

function clearWorkspaceCachePartition(partition: WorkspaceCachePartition): void {
    for (const key of partition.caches.keys()) clearWorkspaceCache(partition, key);
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
        { rootPath: address.rootPath, includeHidden: true },
        {
            serverId: address.serverId,
            ...(accountId ? { accountId } : {}),
            ...(signal ? { signal } : {}),
        },
    );
    throwIfWorkspaceFileSearchAborted(signal);
    if (!res.ok) {
        // Neither a missing root nor a settled custody refusal can be repaired by another route.
        if (res.errorCode === 'root_not_found' || res.errorCode === 'filesystem_identity_custody_unavailable') {
            throw new WorkspaceFileSearchUnavailableError(res.errorCode, res.details);
        }
        return null;
    }
    return { files: buildFileItemsFromPaths(res.paths), truncated: res.truncated };
}

async function buildFileItemsFromRipgrepGlob(
    address: WorkspaceScopeBase,
    accountId: string | null,
    query: string,
    signal: AbortSignal | undefined,
): Promise<Readonly<{ files: FileSearchItem[]; truncated: boolean }> | null> {
    throwIfWorkspaceFileSearchAborted(signal);
    const trimmed = query.trim();
    if (!trimmed) return null;

    const res = await machineWorkspaceFileList(
        address.machineId,
        { rootPath: address.rootPath, query: trimmed, includeHidden: true },
        {
            serverId: address.serverId,
            ...(accountId ? { accountId } : {}),
            ...(signal ? { signal } : {}),
        },
    );
    throwIfWorkspaceFileSearchAborted(signal);
    if (!res.ok) throw new WorkspaceFileSearchUnavailableError(res.errorCode, 'details' in res ? res.details : undefined);
    return { files: buildFileItemsFromPaths(res.paths), truncated: res.truncated };
}

function joinPathAbsolute(rootPath: string, directoryPath: string): string {
    const root = rootPath.replace(/\/+$/g, '');
    const rel = directoryPath.replace(/^\/+/g, '');
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

    while (queue.length > 0) {
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
            truncated = true;
            continue;
        }
        throwIfWorkspaceFileSearchAborted(signal);
        if (!response.ok && response.errorCode === 'filesystem_identity_custody_unavailable') {
            throw new WorkspaceFileSearchUnavailableError(response.errorCode, response.details);
        }
        if (!response.ok || !Array.isArray(response.entries)) {
            truncated = true;
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

                if (!visited.has(nestedDirectory)) {
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

        }
    }

    return answered ? { files, truncated } : null;
}

async function ensureCacheValid(input: Readonly<{
    scope: WorkspaceScopeBase;
    partition: WorkspaceCachePartition;
    workspaceCacheKey: string;
    accountLifetime: WorkspaceFileSearchAccountLifetime | null;
    signal?: AbortSignal;
}>): Promise<WorkspaceCache> {
    const cache = getOrCreateWorkspaceCache(input.partition, input.workspaceCacheKey);
    throwIfWorkspaceFileSearchAborted(input.signal);
    throwIfWorkspaceFileSearchAccountRetired(input.accountLifetime);

    // Cache is invalidated explicitly by SCM snapshot updates and user refresh actions.
    if (cache.initialized) {
        return cache;
    }

    // Keystrokes cancel their wait, not the shared inventory needed by the next query.
    cache.refresh ??= (async () => {
        const signal = cache.signal;
        const address = input.scope;
        try {
            let result: Readonly<{ files: FileSearchItem[]; truncated: boolean }> | null = null;
            try {
                result = await buildFileItemsFromRipgrep(
                    address,
                    readWorkspaceFileSearchAccountId(input.accountLifetime),
                    signal,
                );
            } catch (error) {
                if (signal.aborted) throw error;
                if (error instanceof WorkspaceFileSearchUnavailableError
                    && (error.errorCode === 'root_not_found' || error.errorCode === 'filesystem_identity_custody_unavailable')) throw error;
            }

            throwIfWorkspaceFileSearchAborted(signal);
            if (!result) {
                result = await buildFileItemsFromDirectoryFallback(
                    address,
                    readWorkspaceFileSearchAccountId(input.accountLifetime),
                    signal,
                );
            }
            throwIfWorkspaceFileSearchAccountRetired(input.accountLifetime);
            throwIfWorkspaceFileSearchAborted(signal);
            if (!result) throw new WorkspaceFileSearchUnavailableError();

            cache.files = result.files;
            cache.truncated = result.truncated;
            cache.initialized = true;
            indexWorkspaceFiles(cache);
        } catch (error) {
            throwIfWorkspaceFileSearchAccountRetired(input.accountLifetime);
            throw error;
        } finally {
            cache.refresh = null;
        }
    })();
    await awaitWorkspaceFileSearchWork(cache.refresh, input.signal);
    return cache;
}

function indexWorkspaceFiles(cache: WorkspaceCache): void {
    cache.onlyFiles = [];
    cache.onlyFolders = [];
    cache.filePaths = new Set();
    cache.paths = new Set();
    for (const file of cache.files) {
        cache.paths.add(file.fullPath);
        if (file.fileType === 'file') {
            cache.onlyFiles.push(file);
            cache.filePaths.add(file.fullPath);
        } else {
            cache.onlyFolders.push(file);
        }
    }
    cache.index = cache.files.length > 0 ? createWorkspaceFileSearchIndex(cache.files) : null;
    cache.fileIndex = cache.onlyFiles.length > 0 ? createWorkspaceFileSearchIndex(cache.onlyFiles) : null;
}

export const workspaceFileSearchCache = {
    /** Last observed listing for this exact Account lifetime; never crosses Accounts or issues an RPC. */
    readFiles(scope: WorkspaceScopeBase, lifetime: WorkspaceFileSearchAccountLifetime): readonly FileSearchItem[] | null {
        if (!lifetime.isCurrent()) return null;
        const key = tryBuildWorkspaceCacheKey(scope);
        return key ? workspaceCachePartitions.get(lifetime)?.caches.get(key)?.files ?? null : null;
    },
    /** File membership is admitted with the listing, rather than rebuilt by every Recent/query reader. */
    readFilePaths(scope: WorkspaceScopeBase, lifetime: WorkspaceFileSearchAccountLifetime): ReadonlySet<string> | null {
        if (!lifetime.isCurrent()) return null;
        const key = tryBuildWorkspaceCacheKey(scope);
        const cache = key ? workspaceCachePartitions.get(lifetime)?.caches.get(key) : null;
        return cache?.initialized ? cache.filePaths : null;
    },
    /** Offline quick open indexes its admitted Recent/Changed inventory in this same retiring workspace owner. */
    readLocalIndex(scope: WorkspaceScopeBase, lifetime: WorkspaceFileSearchAccountLifetime, input: Readonly<{
        recent: readonly FileSearchItem[];
        changed: readonly Readonly<{ fullPath: string; fileName: string; filePath: string }>[];
    }>): WorkspaceLocalFileIndex | null {
        if (!lifetime.isCurrent()) return null;
        const key = tryBuildWorkspaceCacheKey(scope);
        if (!key) return null;
        const cache = getOrCreateWorkspaceCache(getOrCreateWorkspaceCachePartition(lifetime), key);
        if (cache.localIndex?.recent === input.recent && cache.localIndex.changed === input.changed) return cache.localIndex.index;
        const byPath = new Map<string, FileSearchItem>();
        for (const file of input.recent) byPath.set(file.fullPath, file);
        for (const file of input.changed) byPath.set(file.fullPath, {
            fullPath: file.fullPath, fileName: file.fileName, filePath: file.filePath, fileType: 'file',
        });
        const files = [...byPath.values()];
        const matcher = createWorkspaceFileSearchIndex(files);
        const index: WorkspaceLocalFileIndex = { files, byPath,
            search: query => rankFileSearchResults(matcher.search(query), query) };
        cache.localIndex = { ...input, index };
        return index;
    },
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
            clearWorkspaceCache(partition, workspaceCacheKey);
        }
    },

    clearAll() {
        for (const partition of workspaceCachePartitions.values()) {
            clearWorkspaceCachePartition(partition);
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
    resultType?: FileSearchItem['fileType'];
    /** Explicit captured lifetime; otherwise the addressed Home's credentials own the search. */
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
        ? Math.max(1, Math.floor(input.limit))
        : input.mode === 'glob' ? Infinity : 10;
    const project = (items: readonly FileSearchItem[], corpusTruncated: boolean) => {
        const page = items.slice(0, limit);
        return input.includeCoverage === true
            ? Object.freeze({ items: Object.freeze(page), corpusTruncated, hasMore: corpusTruncated || items.length > limit })
            : page;
    };
    throwIfWorkspaceFileSearchAborted(input.signal);
    const accountLifetime = await awaitWorkspaceFileSearchWork(
        resolveWorkspaceFileSearchAccountLifetime(input.scope.serverId, input.accountLifetime), input.signal,
    );
    throwIfWorkspaceFileSearchAborted(input.signal);
    throwIfWorkspaceFileSearchAccountRetired(accountLifetime);
    if (input.mode === 'glob') {
        const response = await machineWorkspaceFileList(input.scope.machineId, {
            rootPath: input.scope.rootPath,
            query: input.query.trim(),
            includeHidden: input.includeHidden ?? true,
            ...(input.limit === undefined ? {} : { limit: Math.max(1, Math.floor(input.limit)) }),
        }, {
            serverId: input.scope.serverId,
            ...(readWorkspaceFileSearchAccountId(accountLifetime) ? { accountId: readWorkspaceFileSearchAccountId(accountLifetime) } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        throwIfWorkspaceFileSearchAborted(input.signal);
        throwIfWorkspaceFileSearchAccountRetired(accountLifetime);
        if (!response.ok) throw new WorkspaceFileSearchUnavailableError(response.errorCode, 'details' in response ? response.details : undefined);
        const items = buildFileItemsFromPaths(response.paths);
        return project(input.resultType ? items.filter((item) => item.fileType === input.resultType) : items, response.truncated);
    }
    const partition = getOrCreateWorkspaceCachePartition(accountLifetime);
    // Fails closed on a scope that names no workspace, exactly as the empty-key guard this
    // replaces did — an unaddressable workspace has no index to search.
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(input.scope);
    if (!workspaceCacheKey) return project([], false);

    const cache = await ensureCacheValid({
        scope: input.scope,
        partition,
        workspaceCacheKey,
        accountLifetime,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfWorkspaceFileSearchAborted(input.signal);
    throwIfWorkspaceFileSearchAccountRetired(accountLifetime);

    if ((!cache.index || cache.files.length === 0) && !cache.truncated) {
        return project([], false);
    }
    const searchableFiles = input.resultType
        ? input.resultType === 'file' ? cache.onlyFiles : cache.onlyFolders
        : cache.files;
    if (searchableFiles.length === 0 && !cache.truncated) return project([], false);

    const query = String(input.query ?? '').trim();
    if (!query) {
        throwIfWorkspaceFileSearchAborted(input.signal);
        return project(searchableFiles, cache.truncated);
    }

    const index = input.resultType === 'file'
        ? cache.fileIndex
        : input.resultType
        ? createWorkspaceFileSearchIndex(searchableFiles)
        : cache.index;
    const cachedResults = index?.search(query) ?? [];
    if (!cache.truncated) {
        throwIfWorkspaceFileSearchAborted(input.signal);
        return project(rankFileSearchResults(cachedResults, query, limit + 1), false);
    }

    const globResult = await buildFileItemsFromRipgrepGlob(
        input.scope,
        readWorkspaceFileSearchAccountId(accountLifetime),
        query,
        input.signal,
    );
    throwIfWorkspaceFileSearchAborted(input.signal);
    throwIfWorkspaceFileSearchAccountRetired(accountLifetime);
    if (!globResult) {
        return project(rankFileSearchResults(cachedResults, query, limit + 1), cache.truncated);
    }

    const known = cache.paths;
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
        indexWorkspaceFiles(cache);
    }
    // A targeted query can discover that the canonical workspace corpus is still
    // incomplete. Retain that fact on the lifetime-scoped cache so an identical
    // subsequent query cannot incorrectly treat the cache as complete and skip
    // the bounded query operation.
    cache.truncated = cache.truncated || globResult.truncated;

    throwIfWorkspaceFileSearchAborted(input.signal);
    const mergedSearchable = input.resultType
        ? input.resultType === 'file' ? cache.onlyFiles : cache.onlyFolders
        : cache.files;
    const mergedIndex = input.resultType === 'file' ? cache.fileIndex
        : !input.resultType ? cache.index : createWorkspaceFileSearchIndex(mergedSearchable);
    const merged = rankFileSearchResults(mergedIndex?.search(query) ?? [], query, limit + 1);
    return project(merged, cache.truncated || globResult.truncated);
}
