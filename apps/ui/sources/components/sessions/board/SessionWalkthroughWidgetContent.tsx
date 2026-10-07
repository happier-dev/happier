import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionScmWalkthrough } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { useWalkthroughReviewedMarks } from '@/components/sessions/files/walkthrough/useWalkthroughReviewedMarks';
import { buildWalkthroughReadingProgress, type WalkthroughReadingProgress } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    body: { gap: 12, minWidth: 0 },
    progress: { ...Typography.default(), fontSize: 13, color: theme.colors.text.tertiary },
    title: { ...Typography.default('semiBold'), fontSize: 16, color: theme.colors.text.primary },
}));

/** A read-only projection inside the existing Board frame; it never persists personal progress. */
export function WalkthroughWidgetContentView(props: Readonly<{
    reading: WalkthroughReadingProgress | null;
    marksLoaded: boolean;
    onOpen?: () => void;
    testID: string;
}>) {
    const styles = stylesheet;
    const reading = props.reading;
    const next = props.marksLoaded ? reading?.stops.find((stop) => !stop.reviewed) ?? null : null;
    return <View testID={props.testID} style={styles.body}>
        {reading && props.marksLoaded ? <Text testID={`${props.testID}-progress`} style={styles.progress}>
            {t('walkthrough.boardReadProgress', { count: reading.reviewedCount, total: reading.stops.length })}
        </Text> : null}
        <Text testID={`${props.testID}-next`} style={styles.title}>
            {next ? `${t('walkthrough.nextStop')} · ${next.title}`
                : reading?.stops.length && !props.marksLoaded ? reading.title ?? t('walkthrough.eyebrow')
                : reading?.stops.length ? t('walkthrough.done')
                    : reading?.phase === 'inventory' || reading?.phase === 'arriving' ? t('walkthrough.readingChanges')
                        : t('walkthrough.none.title')}
        </Text>
        {props.onOpen ? <RoundButton testID={`${props.testID}-open`} title={t('turnChanges.card.walkThrough')}
            onPress={props.onOpen} size="small" display="inverted" /> : null}
    </View>;
}

export function SessionWalkthroughWidgetContent(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    comparisonKind: 'session' | 'workingTree';
    interactive: boolean;
    testID: string;
}>) {
    const comparison = React.useMemo(() => ({ kind: props.comparisonKind }), [props.comparisonKind]);
    const result = useSessionScmWalkthrough(props.sessionId, comparison, 'walkthrough', props.serverId);
    const captured = result?.comparison ?? null;
    const marks = useWalkthroughReviewedMarks({ comparison: captured, serverId: props.serverId });
    const reading = React.useMemo(() => captured ? buildWalkthroughReadingProgress({ comparison: captured,
        walkthrough: result?.outputs?.walkthrough ?? null, reviewed: marks.record,
    }) : null, [captured, result?.outputs?.walkthrough, marks.record]);
    const router = useRouter();
    const onOpen = React.useCallback(() => router.push(buildSessionDetailsHref({
        sessionId: props.sessionId, serverId: props.serverId,
        details: { kind: 'scmReview', comparison, view: 'walkthrough' },
    }) as never), [comparison, props.serverId, props.sessionId, router]);
    return <WalkthroughWidgetContentView reading={reading} marksLoaded={captured !== null && marks.record?.comparisonId === captured.id}
        {...(props.interactive ? { onOpen } : {})} testID={props.testID} />;
}
