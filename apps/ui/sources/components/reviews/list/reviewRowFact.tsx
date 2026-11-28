import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { HappierTone } from '@happier-dev/plugin-ui/presentation';
import type { ReviewListResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { projectHappierReviewGlance } from '@happier-dev/plugin-ui/components';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

type ReviewRow = ReviewListResponseV1['items'][number];

export type ReviewRowFact = Readonly<{
    label: string;
    tone: HappierTone;
    /** The fact is the Review's state word ("Couldn't finish"), so the row's byline does not repeat it. */
    saysState?: true;
}>;

/**
 * A row's one fact (lab list-home): what needs the person, else how the Review came out. A failed Review says so here,
 * with the failure glyph in the failed tone; a running one says so in its state word, so it adds nothing here. Amber
 * only when the person is needed. Every list of Reviews (the collection, Home, a Team's shared Reviews) reads its rows
 * through this.
 */
export function reviewRowFact(item: ReviewRow): ReviewRowFact | null {
    const glance = projectHappierReviewGlance(undefined, item, {
        running: '', failed: t('reviewWalkthrough.collection.stateFailed'),
        noFindings: t('reviewWalkthrough.detail.glanceNoFindings'),
        partialNoFindings: t('reviewWalkthrough.detail.glancePartialNoFindings'),
        allDecided: t('reviewWalkthrough.detail.glanceAllDecided'),
        requestedFromYou: t('reviewWalkthrough.detail.requestedFromYou'),
        toDecide: count => t('reviewWalkthrough.detail.glanceToDecide', { count }),
    });
    if (!glance?.sentence) return null;
    if (glance.tone === 'failed') return { label: glance.sentence, tone: 'danger', saysState: true };
    return { label: glance.sentence, tone: glance.tone === 'attention' ? 'attention' : 'secondary' };
}

/**
 * The fact as a row's meta line; nothing when the row has none. Core text with the status ink, so a Collection row and a
 * core list row (a Team's shared Reviews) draw it alike without a plugin UI environment. A failure keeps its semantic
 * glyph at every size (DESIGN.md "States are part of the design").
 */
export function ReviewRowFactText({ item, suffix }: Readonly<{ item: ReviewRow; suffix?: string }>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const fact = reviewRowFact(item);
    if (!fact) return null;
    const color = fact.tone === 'attention' ? theme.colors.state.attention.textForeground
        : fact.tone === 'danger' ? theme.colors.state.danger.textForeground : theme.colors.text.secondary;
    const text = <Text variant="meta" style={[styles.text, { color }]} numberOfLines={1}>{suffix ? `${fact.label} · ${suffix}` : fact.label}</Text>;
    if (fact.tone !== 'danger') return text;
    return <View style={styles.failed}>
        <Icon name="warning" size={ICON_SIZE.xs} color={theme.colors.state.danger.foreground} />
        {text}
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    failed: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minWidth: 0 },
    text: { flexShrink: 1 },
}));
