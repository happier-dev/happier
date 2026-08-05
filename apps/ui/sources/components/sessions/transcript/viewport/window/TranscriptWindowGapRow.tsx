import * as React from 'react';

import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { t } from '@/text';

import type { TranscriptWindowGapItem } from './transcriptTargetWindowTypes';

export function TranscriptWindowGapRow(props: Readonly<{
    gap: TranscriptWindowGapItem;
}>): React.ReactElement {
    const title = props.gap.direction === 'older'
        ? t('session.transcriptGap.earlierMessages')
        : t('session.transcriptGap.laterMessages');
    return (
        <TranscriptSeparatorRow
            accessibilityLabel={title}
            chipTestID={`transcript-window-gap-chip:${props.gap.direction}`}
            iconName="dots-three"
            testID={`transcript-window-gap:${props.gap.direction}`}
            title={title}
            titleTestID={`transcript-window-gap-title:${props.gap.direction}`}
        />
    );
}
