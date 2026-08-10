/**
 * File-suggestion search: fuzzy file discovery over a machine folder, with an in-memory index.
 *
 * **Addressed by machine + folder, never by session (see `fileSuggestionScope.ts`).** The
 * transport is the machine-scoped `ripgrep` RPC with an explicit `cwd`. That is the same
 * handler the session scope reaches — `registerSessionHandlers` is registered on BOTH handler
 * managers (`api/session/sessionClient.ts` with the session folder, `api/apiMachine.ts` with
 * the daemon's working directory), so those handlers are working-directory-scoped, not
 * session-scoped. Passing `cwd` explicitly is what makes the machine route equivalent, and it
 * is mandatory: without it the daemon would search its own working directory (HOME).
 *
 * Going through the machine also removes a live defect rather than only moving code. Session
 * RPC needs a running session runner, so `@`-file search returned nothing for every inactive
 * session and could not be offered at all before a session existed.
 */

import Fuse from 'fuse.js';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { log } from '@/log';
import { registerSuggestionFileSearchCacheClearer } from '@/sync/domains/input/suggestionFileCacheInvalidation';
import {
    fileSuggestionScopeKey,
    resolveFileSuggestionScopeChildPath,
    type FileSuggestionScope,
} from '@/sync/domains/input/fileSuggestionScope';
// The focused machine-ripgrep op, not the `sync/ops` barrel: `machineRipgrep` is already the
// canonical owner of this RPC (the machine path browser is its other consumer), so the search
// asks it rather than re-implementing the request shape and response normalization here.
import { machineRipgrep as machineRipgrepOp } from '@/sync/ops/machineRipgrep';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { AsyncLock } from '@/utils/system/lock';

export type { FileSuggestionScope } from '@/sync/domains/input/fileSuggestionScope';

export interface FileItem {
    fileName: string;
    filePath: string;
    fullPath: string;
    fileType: 'file' | 'folder';
}

interface SearchOptions {
    limit?: number;
    threshold?: number;
}

interface ScopeCache {
    files: FileItem[];
    fuse: Fuse<FileItem> | null;
    lastRefresh: number;
    refreshLock: AsyncLock;
}

type RipgrepLikeResponse = {
    success?: boolean;
    stdout?: string;
};

type ListDirectoryLikeResponse = {
    success?: boolean;
    entries?: Array<{
        name?: string;
        type?: 'file' | 'directory' | 'other';
    }>;
};

type MachineListDirectoryRequest = Readonly<{
    path: string;
}>;

const FILE_INDEX_FALLBACK_LIMIT = 5000;

async function machineRipgrep(
    scope: FileSuggestionScope,
    args: string[],
): Promise<RipgrepLikeResponse | null> {
    const response = await machineRipgrepOp(scope.machineId, args, scope.path, {
        serverId: scope.serverId ?? null,
    });
    if (response.success !== true) {
        log.log(`[file-suggestions] ripgrep failed for ${scope.machineId}:${scope.path}: ${response.error ?? 'unsuccessful response'}`);
        return null;
    }
    return response;
}

async function machineListDirectory(
    scope: FileSuggestionScope,
    relativePath: string,
): Promise<ListDirectoryLikeResponse | null> {
    try {
        return await machineRpcWithServerScope<ListDirectoryLikeResponse, MachineListDirectoryRequest>({
            machineId: scope.machineId,
            serverId: scope.serverId,
            method: RPC_METHODS.LIST_DIRECTORY,
            // Absolute, always. The daemon rejects an empty path outright ("Path is
            // required") before it ever consults its default directory, which is what made
            // this whole fallback unreachable while it was addressed session-relatively.
            payload: { path: resolveFileSuggestionScopeChildPath(scope, relativePath) },
        });
    } catch (error) {
        log.log(`[file-suggestions] listDirectory failed for ${scope.machineId}:${scope.path}: ${describeError(error)}`);
        return null;
    }
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function shouldSkipFallbackPath(name: string): boolean {
    return name.startsWith('.') || name === 'node_modules';
}

function escapeRipgrepGlob(input: string): string {
    // ripgrep globs follow gitignore-style patterns. Keep this conservative:
    // escape characters that would change meaning in a glob.
    return input
        .replace(/\\/g, '\\\\')
        .replace(/\*/g, '\\*')
        .replace(/\?/g, '\\?')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

class FileSearchCache {
    private scopes = new Map<string, ScopeCache>();

    private getOrCreateScopeCache(scope: FileSuggestionScope): ScopeCache {
        const key = fileSuggestionScopeKey(scope);
        let cache = this.scopes.get(key);
        if (!cache) {
            cache = {
                files: [],
                fuse: null,
                lastRefresh: 0,
                refreshLock: new AsyncLock()
            };
            this.scopes.set(key, cache);
        }
        return cache;
    }

    private initializeFuse(cache: ScopeCache) {
        if (cache.files.length === 0) {
            cache.fuse = null;
            return;
        }

        const fuseOptions = {
            keys: [
                { name: 'fileName', weight: 0.7 },  // Higher weight for file/directory name
                { name: 'fullPath', weight: 0.3 }   // Lower weight for full path
            ],
            threshold: 0.3,
            includeScore: true,
            shouldSort: true,
            minMatchCharLength: 1,
            ignoreLocation: true,
            useExtendedSearch: true,
            // Allow fuzzy matching on slashes for directories
            distance: 100
        };

        cache.fuse = new Fuse(cache.files, fuseOptions);
    }

    private buildFileItemsFromPaths(filePaths: string[]): FileItem[] {
        const files: FileItem[] = [];

        filePaths.forEach((path: string) => {
            const parts = path.split('/');
            const fileName = parts[parts.length - 1] || path;
            const filePath = parts.slice(0, -1).join('/') || '';

            files.push({
                fileName,
                filePath: filePath ? filePath + '/' : '',
                fullPath: path,
                fileType: 'file' as const
            });
        });

        const directories = new Set<string>();
        filePaths.forEach((path: string) => {
            const parts = path.split('/');
            for (let i = 1; i <= parts.length - 1; i++) {
                const dirPath = parts.slice(0, i).join('/');
                if (dirPath) {
                    directories.add(dirPath);
                }
            }
        });

        directories.forEach((dirPath) => {
            const parts = dirPath.split('/');
            const dirName = (parts[parts.length - 1] || dirPath) + '/';
            const parentPath = parts.slice(0, -1).join('/');

            files.push({
                fileName: dirName,
                filePath: parentPath ? parentPath + '/' : '',
                fullPath: dirPath + '/',
                fileType: 'folder'
            });
        });

        return files;
    }

    private async buildFileItemsFromRipgrep(scope: FileSuggestionScope): Promise<FileItem[] | null> {
        const response = await machineRipgrep(scope, ['--files', '--follow']);

        if (!response || response.success !== true || typeof response.stdout !== 'string') {
            return null;
        }

        const filePaths: string[] = response.stdout
            .split('\n')
            .filter((path: string) => path.trim().length > 0);

        return this.buildFileItemsFromPaths(filePaths);
    }

    private async buildFileItemsFromRipgrepGlob(scope: FileSuggestionScope, query: string, limit: number): Promise<FileItem[] | null> {
        const trimmed = query.trim();
        if (!trimmed) return null;

        // Allow multi-token queries to match across separators.
        const needle = escapeRipgrepGlob(trimmed).replace(/\s+/g, '*');
        const pattern = `*${needle}*`;

        const response = await machineRipgrep(scope, ['--files', '--follow', '--hidden', '--iglob', pattern]);

        if (!response || response.success !== true || typeof response.stdout !== 'string') {
            return null;
        }

        const filePaths: string[] = response.stdout
            .split('\n')
            .map((p) => p.trim())
            .filter(Boolean)
            .slice(0, Math.max(50, limit * 5));

        if (filePaths.length === 0) return null;
        return this.buildFileItemsFromPaths(filePaths);
    }

    private async buildFileItemsFromDirectoryFallback(scope: FileSuggestionScope): Promise<FileItem[] | null> {
        const files: FileItem[] = [];
        // Bookkeeping stays RELATIVE to the scope root — that is what the composer inserts as
        // a token and what ripgrep `--files` produces — while each request is made absolute.
        const queue: string[] = [''];
        const visited = new Set<string>(['']);

        while (queue.length > 0 && files.length < FILE_INDEX_FALLBACK_LIMIT) {
            const directoryPath = queue.shift()!;
            const response = await machineListDirectory(scope, directoryPath);
            if (!response || response.success !== true || !Array.isArray(response.entries)) {
                continue;
            }

            for (const entry of response.entries) {
                if (!entry || typeof entry.name !== 'string' || !entry.name) {
                    continue;
                }
                if (shouldSkipFallbackPath(entry.name)) {
                    continue;
                }

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

        if (files.length === 0) {
            return null;
        }

        return files;
    }

    private async ensureCacheValid(scope: FileSuggestionScope): Promise<void> {
        const cache = this.getOrCreateScopeCache(scope);
        // Cache is now invalidated explicitly by git snapshot updates.
        // Only refresh when we have no index yet for this scope.
        if (cache.files.length > 0) {
            return; // Cache is still valid
        }

        // Use lock to prevent concurrent refreshes for this scope
        await cache.refreshLock.inLock(async () => {
            // Double-check after acquiring lock
            const currentTime = Date.now();
            if (currentTime - cache.lastRefresh < 1000) { // Skip if refreshed within last second
                return;
            }

            const filesFromRipgrep = await this.buildFileItemsFromRipgrep(scope);
            const files = filesFromRipgrep ?? await this.buildFileItemsFromDirectoryFallback(scope);
            if (!files || files.length === 0) {
                return;
            }

            cache.files = files;
            cache.lastRefresh = Date.now();
            this.initializeFuse(cache);
        });
    }

    async search(scope: FileSuggestionScope, query: string, options: SearchOptions = {}): Promise<FileItem[]> {
        await this.ensureCacheValid(scope);
        const cache = this.getOrCreateScopeCache(scope);

        if (!cache.fuse || cache.files.length === 0) {
            return [];
        }

        const { limit = 10, threshold = 0.3 } = options;

        // If query is empty, return most recently modified files
        if (!query || query.trim().length === 0) {
            return cache.files.slice(0, limit);
        }

        // Perform fuzzy search
        const searchOptions = {
            limit,
            threshold
        };

        const results = cache.fuse.search(query, searchOptions);
        if (results.length > 0) {
            return results.map(result => result.item);
        }

        // If the initial index is incomplete (e.g., truncated transport), try a targeted glob request.
        // This keeps UX predictable for exact-ish filename queries without having to ship a full file index.
        const globItems = await this.buildFileItemsFromRipgrepGlob(scope, query, limit);
        if (!globItems || globItems.length === 0) {
            return [];
        }

        // Opportunistically merge results into the cache to improve subsequent searches.
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
            this.initializeFuse(cache);
        }

        return globItems.slice(0, limit);
    }

    getAllFiles(scope: FileSuggestionScope): FileItem[] {
        const cache = this.scopes.get(fileSuggestionScopeKey(scope));
        return cache ? [...cache.files] : [];
    }

    /**
     * Drops one workspace's index. Clearing "everything" is a separate, explicitly named
     * operation: a single optional parameter meaning *either* "one scope" *or* "all scopes"
     * turns a scope that failed to resolve into a silent full cache wipe.
     */
    clearCache(scope: FileSuggestionScope): void {
        this.scopes.delete(fileSuggestionScopeKey(scope));
    }

    clearAll(): void {
        this.scopes.clear();
    }
}

// Export singleton instance
export const fileSearchCache = new FileSearchCache();
registerSuggestionFileSearchCacheClearer((scope) => fileSearchCache.clearCache(scope));

// Main export: search files with fuzzy matching
export async function searchFiles(
    scope: FileSuggestionScope,
    query: string,
    options: SearchOptions = {}
): Promise<FileItem[]> {
    return fileSearchCache.search(scope, query, options);
}
