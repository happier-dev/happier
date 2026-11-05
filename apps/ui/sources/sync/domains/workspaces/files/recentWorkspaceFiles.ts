import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type RecentWorkspaceFiles = Readonly<Record<string, string[]>>;
// The approved recent-list length; the oldest path drops when another file opens.
const RECENT_WORKSPACE_FILE_COUNT = 20;

/** Opening history belongs to an Account, not merely an accessible workspace address. */
export function recentWorkspaceFilesKey(scope: ServerAccountScope, workspaceKey: string): string {
    return serverAccountScopedResourceKey(scope, 'recent-workspace-files', workspaceKey);
}

export function parseRecentWorkspaceFiles(value: unknown): Record<string, string[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([key, paths]) => Array.isArray(paths)
        ? [[key, [...new Set(paths.filter((path): path is string => typeof path === 'string' && path.length > 0))]
            .slice(0, RECENT_WORKSPACE_FILE_COUNT)]] : []));
}

export function recordRecentWorkspaceFile(previous: RecentWorkspaceFiles, workspaceKey: string, path: string): RecentWorkspaceFiles {
    if (!workspaceKey || !path || previous[workspaceKey]?.[0] === path) return previous;
    return { ...previous, [workspaceKey]: [...new Set([path, ...(previous[workspaceKey] ?? [])])]
        .slice(0, RECENT_WORKSPACE_FILE_COUNT) };
}

export function workspacePathToFileSearchItem(path: string): FileSearchItem {
    const separator = path.lastIndexOf('/');
    return { fullPath: path, fileName: path.slice(separator + 1), filePath: separator < 0 ? '' : path.slice(0, separator + 1), fileType: 'file' };
}

export function selectRecentWorkspaceFiles(paths: readonly string[], existingPaths: readonly string[] | null, matchingPaths?: ReadonlySet<string>): string[] {
    const existing = existingPaths === null ? null : new Set(existingPaths);
    return paths.filter(path => (existing === null || existing.has(path)) && (!matchingPaths || matchingPaths.has(path)));
}
