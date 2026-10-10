import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { queryRanges } from '@/components/ui/text/queryRanges';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

/** One conversation hit everywhere: two lines of matched text, then the quiet where/when. */
export function ConversationHitSummary(props: Readonly<{
    snippet: string;
    query?: string;
    where?: string | null;
    atMs?: number;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const density = useResolvedItemDensity(undefined);
    const meta = [props.where, props.atMs && props.atMs > 0 ? formatShortRelativeTime(props.atMs) : ''].filter(Boolean).join(' · ');
    return <View style={{ gap: 2 }}>
        <Text testID={props.testID} numberOfLines={2} style={[Typography.default(), ITEM_SUBTITLE_TEXT_METRICS[density], { color: theme.colors.text.secondary }]}>
            <FindHighlightedText text={props.snippet} ranges={queryRanges(props.snippet, props.query ?? '')} />
        </Text>
        {meta ? <Text numberOfLines={1} style={[Typography.rowMeta(), Typography.tabular(), { color: theme.colors.text.tertiary }]}>{meta}</Text> : null}
    </View>;
}
