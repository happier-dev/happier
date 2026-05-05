import * as React from 'react';

import { t } from '@/text';

import type { DesktopActivityOverlayVisualMode } from '../DesktopActivityOverlayVisualMode';
import type { DesktopActivityOverlayExpandedCard } from '../shared/desktopActivityOverlayUiModel';
import { DesktopActivityOverlayCardFrame } from './DesktopActivityOverlayCardFrame';

type QuotaSummaryCard = Extract<DesktopActivityOverlayExpandedCard, { kind: 'quota_summary' }>;

export function DesktopActivityOverlayQuotaSummaryCard(props: Readonly<{
    card: QuotaSummaryCard;
    visualMode: DesktopActivityOverlayVisualMode;
    testID: string;
}>): React.ReactElement {
    return (
        <DesktopActivityOverlayCardFrame
            testID={props.testID}
            visualMode={props.visualMode}
            eyebrow={t('usage.activity')}
            title={props.card.title}
            body={props.card.summary}
        />
    );
}
