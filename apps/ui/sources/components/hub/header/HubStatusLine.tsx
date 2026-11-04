import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useActivityOverviewSummary } from '@/activity/source/useActivityOverview';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * Home's one line about the present, under the greeting: "◌ 2 sessions working · ● 1 needs you",
 * from the same Activity summary the Inbox badge reads (never a second classification), then which
 * Home this is. It always holds one line, so the page below never moves as sessions start and stop.
 * It is a leaf: a session change re-renders this line only.
 */
export const HubStatusLine = React.memo(function HubStatusLine(props: Readonly<{
    home: (detail: 'full' | 'name') => React.ReactNode;
}>) {
    const summary = useActivityOverviewSummary();
    return <HubStatusLineView working={summary.workingCount} needsYou={summary.needsYouCount} isDataReady={summary.isDataReady} home={props.home} />;
});

/**
 * The line as drawn for given counts (the `/dev/home` fixture draws it too): what is working and
 * what needs the person, then which Home this is. With nothing running it says so, then the Home and
 * where it lives in full (J1).
 */
export function HubStatusLineView(props: Readonly<{
    working: number;
    needsYou: number;
    isDataReady?: boolean;
    home: (detail: 'full' | 'name') => React.ReactNode;
}>) {
    const { working, needsYou } = props;
    const idle = working === 0 && needsYou === 0;
    return (
        <View testID="home-hub.status" style={styles.line}>
            {idle && props.isDataReady !== false ? <Text style={styles.text} numberOfLines={1}>{t('homeIndex.nothingRunning')}</Text> : null}
            {working > 0 ? (
                <View testID="home-hub.status.working" style={styles.fact}>
                    <WorkStatusGlyph
                        status={{ state: 'thinking', bucket: 'working', tone: 'neutral', word: '', attentionType: null, glyph: 'refresh' }}
                        testIDSuffix="home-status"
                    />
                    <Text style={styles.text}>{t('homeIndex.sessionsWorking', { count: working })}</Text>
                </View>
            ) : null}
            {needsYou > 0 ? (
                <View testID="home-hub.status.needsYou" style={styles.fact}>
                    <WorkStatusGlyph
                        status={{ state: 'needs_you', bucket: 'needs_you', tone: 'attention', word: '', attentionType: null, glyph: 'attention' }}
                        testIDSuffix="home-status"
                        animationEnabled={false}
                    />
                    <Text style={styles.text}>{t('homeIndex.sessionsNeedYou', { count: needsYou })}</Text>
                </View>
            ) : null}
            {props.home(idle ? 'full' : 'name')}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    line: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s8,
        rowGap: theme.space.s2,
        minHeight: 20,
    },
    fact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    text: {
        color: theme.colors.text.secondary,
        ...happierPageTextMetrics('pageDescription'),
        fontVariant: ['tabular-nums'],
    },
}));
