import type { ScmFileStatus } from './scmStatusFiles';

/**
 * Single owner for "this row is a collapsed directory, not a file" — consumed
 * by every flat changed-files surface to keep directory rows away from
 * per-file-only actions (diff/discard act on file paths; untracked discard
 * deletes). Honors the snapshot's explicit `isDirectory` flag first (no shape
 * sniffing), then the trailing-separator form collapsed entries carry.
 */
export function isDirectoryLikeScmFileStatus(file: Pick<ScmFileStatus, 'fullPath'> & { isDirectory?: boolean }): boolean {
    if (file.isDirectory === true) return true;
    const fullPath = typeof file.fullPath === 'string' ? file.fullPath.trim() : '';
    if (!fullPath) return false;
    return fullPath.endsWith('/') || fullPath.endsWith('\\');
}

export function filterDirectoryLikeScmFileStatuses(files: readonly ScmFileStatus[]): ScmFileStatus[] {
    return files.filter((file) => !isDirectoryLikeScmFileStatus(file));
}
