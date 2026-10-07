import { classifyScmChangePath } from '@happier-dev/protocol/scm/comparison';

import { t } from '@/text';

/**
 * The label a change list shows for a file's evidence class ("Lockfile", "Generated"), from the one
 * path classifier the host capture uses. Null for ordinary source.
 */
export function resolveScmChangePathTag(path: string): string | null {
    const kind = classifyScmChangePath(path);
    if (kind.lockfile) return t('scmComparison.lockfileTag');
    if (kind.generated) return t('scmComparison.generatedTag');
    return null;
}
