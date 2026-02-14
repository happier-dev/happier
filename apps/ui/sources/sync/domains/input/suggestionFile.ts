/**
 * Suggestion file search functionality using ripgrep for fast file discovery
 * Provides fuzzy search capabilities with in-memory caching for autocomplete suggestions
 */

import Fuse from 'fuse.js';
import { sessionListDirectory, sessionRipgrep } from '../../ops';
import { AsyncLock } from '@/utils/system/lock';

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

interface SessionCache {
    files: FileItem[];
    fuse: Fuse<FileItem> | null;
    lastRefresh: number;
    refreshLock: AsyncLock;
}

type SessionRipgrepLikeResponse = {
    success?: boolean;
    stdout?: string;
};

type SessionListDirectoryLikeResponse = {
    success?: boolean;
    entries?: Array<{
        name?: string;
        type?: 'file' | 'directory' | 'other';
    }>;
};

const FILE_INDEX_FALLBACK_LIMIT = 5000;

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
    private sessions = new Map<string, SessionCache>();

    private getOrCreateSessionCache(sessionId: string): SessionCache {
        let cache = this.sessions.get(sessionId);
        if (!cache) {
            cache = {
                files: [],
                fuse: null,
                lastRefresh: 0,
                refreshLock: new AsyncLock()
            };
            this.sessions.set(sessionId, cache);
        }
        return cache;
    }

    private initializeFuse(cache: SessionCache) {
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

    private async buildFileItemsFromRipgrep(sessionId: string): Promise<FileItem[] | null> {
        let response: SessionRipgrepLikeResponse | null = null;
        try {
            response = await sessionRipgrep(
                sessionId,
                ['--files', '--follow'],
                undefined
            ) as SessionRipgrepLikeResponse | null;
        } catch {
            return null;
        }

        if (!response || response.success !== true || typeof response.stdout !== 'string') {
            return null;
        }

        const filePaths: string[] = response.stdout
            .split('\n')
            .filter((path: string) => path.trim().length > 0);

        return this.buildFileItemsFromPaths(filePaths);
    }

    private async buildFileItemsFromRipgrepGlob(sessionId: string, query: string, limit: number): Promise<FileItem[] | null> {
        const trimmed = query.trim();
        if (!trimmed) return null;

        // Allow multi-token queries to match across separators.
        const needle = escapeRipgrepGlob(trimmed).replace(/\s+/g, '*');
        const pattern = `*${needle}*`;

        let response: SessionRipgrepLikeResponse | null = null;
        try {
            response = await sessionRipgrep(
                sessionId,
                ['--files', '--follow', '--hidden', '--iglob', pattern],
                undefined
            ) as SessionRipgrepLikeResponse | null;
        } catch {
            return null;
        }

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

    private async buildFileItemsFromDirectoryFallback(sessionId: string): Promise<FileItem[] | null> {
        const files: FileItem[] = [];
        const queue: string[] = [''];
        const visited = new Set<string>(['']);

        while (queue.length > 0 && files.length < FILE_INDEX_FALLBACK_LIMIT) {
            const directoryPath = queue.shift()!;
            const response = await sessionListDirectory(sessionId, directoryPath) as SessionListDirectoryLikeResponse | null;
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

    private async ensureCacheValid(sessionId: string): Promise<void> {
        const cache = this.getOrCreateSessionCache(sessionId);
        // Cache is now invalidated explicitly by git snapshot updates.
        // Only refresh when we have no index yet for this session.
        if (cache.files.length > 0) {
            return; // Cache is still valid
        }

        // Use lock to prevent concurrent refreshes for this session
        await cache.refreshLock.inLock(async () => {
            // Double-check after acquiring lock
            const currentTime = Date.now();
            if (currentTime - cache.lastRefresh < 1000) { // Skip if refreshed within last second
                return;
            }

            const filesFromRipgrep = await this.buildFileItemsFromRipgrep(sessionId);
            const files = filesFromRipgrep ?? await this.buildFileItemsFromDirectoryFallback(sessionId);
            if (!files || files.length === 0) {
                return;
            }

            cache.files = files;
            cache.lastRefresh = Date.now();
            this.initializeFuse(cache);
        });
    }

    async search(sessionId: string, query: string, options: SearchOptions = {}): Promise<FileItem[]> {
        await this.ensureCacheValid(sessionId);
        const cache = this.getOrCreateSessionCache(sessionId);

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
        const globItems = await this.buildFileItemsFromRipgrepGlob(sessionId, query, limit);
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

    getAllFiles(sessionId: string): FileItem[] {
        const cache = this.sessions.get(sessionId);
        return cache ? [...cache.files] : [];
    }

    clearCache(sessionId?: string): void {
        if (sessionId) {
            this.sessions.delete(sessionId);
        } else {
            this.sessions.clear();
        }
    }
}

// Export singleton instance
export const fileSearchCache = new FileSearchCache();

// Main export: search files with fuzzy matching
export async function searchFiles(
    sessionId: string,
    query: string,
    options: SearchOptions = {}
): Promise<FileItem[]> {
    return fileSearchCache.search(sessionId, query, options);
}
