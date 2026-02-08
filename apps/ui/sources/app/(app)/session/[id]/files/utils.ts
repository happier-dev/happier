import type { GitFileStatus, GitStatusFiles } from '@/sync/git/gitStatusFiles';

export function normalizeFilePath(path: string): string {
    if (!path) return path;
    return path.endsWith('/') ? path.slice(0, -1) : path;
}

export function buildAllRepositoryChangedFiles(
    gitStatusFiles: Pick<GitStatusFiles, 'unstagedFiles' | 'stagedFiles'> | null
): GitFileStatus[] {
    if (!gitStatusFiles) return [];
    const mergedByPath = new Map<string, GitFileStatus>();
    for (const file of [...gitStatusFiles.unstagedFiles, ...gitStatusFiles.stagedFiles]) {
        if (!mergedByPath.has(file.fullPath)) {
            mergedByPath.set(file.fullPath, file);
        }
    }
    return Array.from(mergedByPath.values()).sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

export function formatLineChanges(file: Pick<GitFileStatus, 'linesAdded' | 'linesRemoved'>): string {
    const parts = [];
    if (file.linesAdded > 0) {
        parts.push(`+${file.linesAdded}`);
    }
    if (file.linesRemoved > 0) {
        parts.push(`-${file.linesRemoved}`);
    }
    return parts.length > 0 ? parts.join(' ') : '';
}

export function formatFileSubtitle(file: Pick<GitFileStatus, 'filePath' | 'linesAdded' | 'linesRemoved'>, projectRootLabel: string): string {
    const lineChanges = formatLineChanges(file);
    const pathPart = file.filePath || projectRootLabel;
    return lineChanges ? `${pathPart} • ${lineChanges}` : pathPart;
}
