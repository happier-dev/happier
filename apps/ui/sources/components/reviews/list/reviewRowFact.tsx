import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { HappierTone } from '@happier-dev/plugin-ui/presentation';
import type { ReviewListResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

type ReviewRow = ReviewListResponseV1['items'][number];

/**
 * A row's one fact (lab list-home): what needs the person, else how the Review came out. A running or failed Review
 * says so in its state word, so it adds nothing here. Amber only when the person is needed. Every list of Reviews
 * (the collection, Home, a Team's shared Reviews) reads its rows through this.
 */
export function reviewRowFact(item: ReviewRow): Readonly<{ label: string; tone: HappierTone }> | null {
    if (item.counts.needsDecision > 0) {
        return { label: t('reviewWalkthrough.detail.glanceToDecide', { count: item.counts.needsDecision }), tone: 'attention' };
    }
    if (item.needsYou.requestedVerdict) return { label: t('reviewWalkthrough.detail.requestedFromYou'), tone: 'attention' };
    if (item.state !== 'completed' && item.state !== 'partial') return null;
    return { label: item.counts.total === 0 ? t('reviewWalkthrough.detail.glanceNoFindings')
        : t('reviewWalkthrough.detail.glanceAllDecided'), tone: 'secondary' };
}

/**
 * The fact as a row's meta line; nothing when the row has none. Core text with the status ink, so a Collection row and a
 * core list row (a Team's shared Reviews) draw it alike without a plugin UI environment.
 */
export function ReviewRowFactText({ item, suffix }: Readonly<{ item: ReviewRow; suffix?: string }>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const fact = reviewRowFact(item);
    if (!fact) return null;
    const color = fact.tone === 'attention' ? theme.colors.state.attention.textForeground : theme.colors.text.secondary;
    return <Text variant="meta" style={{ color }} numberOfLines={1}>{suffix ? `${fact.label} · ${suffix}` : fact.label}</Text>;
}
