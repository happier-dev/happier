import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { HappierTone } from '@happier-dev/plugin-ui/presentation';
import type { ReviewListResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { projectHappierReviewGlance } from '@happier-dev/plugin-ui/components';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

type ReviewRow = ReviewListResponseV1['items'][number];

/**
 * A row's one fact (lab list-home): what needs the person, else how the Review came out. A running or failed Review
 * says so in its state word, so it adds nothing here. Amber only when the person is needed. Every list of Reviews
 * (the collection, Home, a Team's shared Reviews) reads its rows through this.
 */
export function reviewRowFact(item: ReviewRow): Readonly<{ label: string; tone: HappierTone }> | null {
    const glance = projectHappierReviewGlance(undefined, item, {
        running: '', failed: '',
        noFindings: t('reviewWalkthrough.detail.glanceNoFindings'),
        allDecided: t('reviewWalkthrough.detail.glanceAllDecided'),
        requestedFromYou: t('reviewWalkthrough.detail.requestedFromYou'),
        toDecide: count => t('reviewWalkthrough.detail.glanceToDecide', { count }),
    });
    return glance?.sentence ? { label: glance.sentence, tone: glance.tone === 'attention' ? 'attention' : 'secondary' } : null;
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
