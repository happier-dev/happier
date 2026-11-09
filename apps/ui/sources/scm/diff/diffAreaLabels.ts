import type { ScmDiffArea } from '@happier-dev/protocol/scm/workingSnapshot';

import { isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { t } from '@/text';

/**
 * The words for a diff area. They follow what the areas are, not the backend: with an index (Git
 * staging) they are Unstaged / Staged / Both; with Happier's own commit selection (the atomic
 * strategy) they stay Pending / Included / Combined. The file header and Review's area choice both
 * read them here, so a file never says "Staged" while Review says "Included" for the same thing.
 */
export type ScmDiffAreaVocabulary = 'index' | 'selection';

export function resolveScmDiffAreaVocabulary(commitStrategy: ScmCommitStrategy): ScmDiffAreaVocabulary {
    return isAtomicCommitStrategy(commitStrategy) ? 'selection' : 'index';
}

export function resolveScmDiffAreaLabel(area: ScmDiffArea, vocabulary: ScmDiffAreaVocabulary): string {
    if (vocabulary === 'index') {
        return area === 'pending'
            ? t('detailsSurface.file.areaUnstaged')
            : area === 'included'
                ? t('detailsSurface.file.areaStaged')
                : t('detailsSurface.file.areaBoth');
    }
    return area === 'pending'
        ? t('files.diffModes.pending')
        : area === 'included'
            ? t('files.diffModes.included')
            : t('files.diffModes.combined');
}

export function resolveScmDiffAreaLabels(vocabulary: ScmDiffAreaVocabulary): Readonly<Record<ScmDiffArea, string>> {
    return {
        pending: resolveScmDiffAreaLabel('pending', vocabulary),
        included: resolveScmDiffAreaLabel('included', vocabulary),
        both: resolveScmDiffAreaLabel('both', vocabulary),
    };
}
