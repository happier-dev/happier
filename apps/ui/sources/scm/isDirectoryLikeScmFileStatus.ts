import type { ScmFileStatus } from './scmStatusFiles';

export function isDirectoryLikeScmFileStatus(file: Pick<ScmFileStatus, 'fullPath'>): boolean {
    const fullPath = typeof file.fullPath === 'string' ? file.fullPath.trim() : '';
    if (!fullPath) return false;
    return fullPath.endsWith('/') || fullPath.endsWith('\\');
}

export function filterDirectoryLikeScmFileStatuses(files: readonly ScmFileStatus[]): ScmFileStatus[] {
    return files.filter((file) => !isDirectoryLikeScmFileStatus(file));
}
