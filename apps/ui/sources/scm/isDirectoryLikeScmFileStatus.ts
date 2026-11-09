import { isDirectoryLikeScmPath } from '@happier-dev/protocol/scm';

import type { ScmFileStatus } from './scmStatusFiles';

/** The shared counting owner decides directory rows; the producer's summary uses the same rule. */
export function isDirectoryLikeScmFileStatus(file: Pick<ScmFileStatus, 'fullPath'>): boolean {
    return isDirectoryLikeScmPath(file.fullPath);
}

export function filterDirectoryLikeScmFileStatuses(files: readonly ScmFileStatus[]): ScmFileStatus[] {
    return files.filter((file) => !isDirectoryLikeScmFileStatus(file));
}
