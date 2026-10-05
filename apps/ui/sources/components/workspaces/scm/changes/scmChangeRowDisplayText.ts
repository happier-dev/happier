import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { describeScmChangeKind } from '@/scm/scmChangeKind';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { t } from '@/text';

/** The strings the changed-file row owns, before its name-first/inline composition. */
export function resolveScmChangeRowDisplayText(file: ScmFileStatus, nameFirst: boolean) {
    const { dir, name } = normalizeRepoPathParts(file);
    const complete = file.isComplete !== false;
    return {
        path: dir ? `${dir}/${name}` : name,
        mark: describeScmChangeKind(file.status).code,
        renamedFrom: nameFirst && file.status === 'renamed' && file.oldPath ? t('sessionGitPane.row.renamedFrom', { path: file.oldPath }) : null,
        unavailable: complete ? null : '—',
        added: complete && (!nameFirst || file.linesAdded > 0 || file.linesRemoved <= 0) ? `+${file.linesAdded}` : null,
        removed: complete && (!nameFirst || file.linesRemoved > 0) ? `${nameFirst ? '−' : '-'}${file.linesRemoved}` : null,
    };
}
