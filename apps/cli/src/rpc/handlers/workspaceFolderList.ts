import { join } from 'node:path';

import { WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';

import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { WORKSPACE_FILE_EXCLUDED_DIRECTORY_NAMES } from './workspaceFilePaths';

export type WorkspaceFolderListResult = Readonly<{
    paths: string[];
    truncated: boolean;
    /** Folders whose entries were read: the work this page cost. */
    scannedDirectories: number;
}>;

/** Ordered, case-insensitive parts of a query: `my  app` matches `my-big-app`, as the file glob does. */
function createFolderMatcher(query: string): (name: string, relativePath: string) => boolean {
    const trimmed = query.trim().toLowerCase();
    const parts = trimmed.split(/\s+/u).filter(Boolean);
    const matchesPath = trimmed.includes('/');
    return (name, relativePath) => {
        const haystack = (matchesPath ? relativePath : name).toLowerCase();
        let from = 0;
        for (const part of parts) {
            const at = haystack.indexOf(part, from);
            if (at < 0) return false;
            from = at + part.length;
        }
        return true;
    };
}

/**
 * Folder names under `rootPath`, breadth-first: the page ends after the shallowest level with a match
 * (deeper levels may hold more → `truncated`), so a shallow folder is found after reading a few
 * folders instead of after walking the whole tree. Reads only folder entries; never follows links.
 * Bounds are the caller's: `limit`, the reply byte budget and the operation deadline.
 */
export async function listWorkspaceFolders(input: Readonly<{
    rootPath: string;
    query: string;
    includeHidden: boolean;
    limit?: number;
    maxDepth?: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
}>): Promise<WorkspaceFolderListResult> {
    const source = currentWorkspaceSource();
    const matches = createFolderMatcher(input.query);
    const paths: string[] = [];
    let serializedBytes = Buffer.byteLength(JSON.stringify({ ok: true, paths: [], truncated: false }), 'utf8');
    let truncated = false;
    let scannedDirectories = 0;
    let level: string[] = [''];
    let depth = 0;
    walk: while (level.length > 0) {
        const next: string[] = [];
        depth += 1;
        for (const relativeDirectory of level) {
            input.signal?.throwIfAborted();
            if (input.deadlineAtMs !== undefined && Date.now() >= input.deadlineAtMs) { truncated = true; break walk; }
            let entries: Awaited<ReturnType<typeof source.readdir>>;
            try {
                entries = await source.readdir(relativeDirectory ? join(input.rootPath, relativeDirectory) : input.rootPath);
            } catch (error) {
                if (relativeDirectory === '') throw error;
                // An unreadable folder below the root leaves the listing usable but incomplete.
                truncated = true;
                continue;
            }
            scannedDirectories += 1;
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
                if (WORKSPACE_FILE_EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
                if (!input.includeHidden && entry.name.startsWith('.')) continue;
                const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
                next.push(relativePath);
                if (!matches(entry.name, relativePath)) continue;
                const record = `${relativePath}/`;
                const recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8') + (paths.length > 0 ? 1 : 0);
                if ((input.limit !== undefined && paths.length >= input.limit)
                    || serializedBytes + recordBytes > WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES) {
                    truncated = true;
                    break walk;
                }
                paths.push(record);
                serializedBytes += recordBytes;
            }
        }
        if (input.maxDepth !== undefined && depth >= input.maxDepth) break;
        if (paths.length > 0) { truncated = truncated || next.length > 0; break; }
        level = next;
    }
    return { paths, truncated, scannedDirectories };
}
