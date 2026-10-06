import type { WorkBoardPreviewLayoutV1 } from '@happier-dev/protocol';
import { t } from '@/text';

/** The Board header and its static Artifact preview name the same saved sources. */
export function describeBoardSources(source: WorkBoardPreviewLayoutV1['source']): string {
    const parts = source.sections.map(section => t(`boards.sections.${section}.title`));
    if (source.hasFilter) parts.push(t('boards.sections.filter.title'));
    return parts.length === 0 ? t('boards.meta.handPicked')
        : source.pickedCount > 0 ? `${parts.join(', ')} ${t('boards.meta.moreSources', { count: source.pickedCount })}` : parts.join(', ');
}
