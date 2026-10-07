import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useActivityOverviewSummary } from '@/activity/source/useActivityOverview';
import { SessionRowAttentionIndicator } from '@/components/sessions/shell/row/SessionRowAttentionIndicator';
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
    return <HubStatusLineView working={summary.workingCount} needsYou={summary.needsYouCount} home={props.home} />;
});

/**
 * The line as drawn for given counts (the `/dev/home` fixture draws it too): what is working and
 * what needs the person, then which Home this is. With nothing running it says so, then the Home and
 * where it lives in full (J1).
 */
export function HubStatusLineView(props: Readonly<{
    working: number;
    needsYou: number;
    home: (detail: 'full' | 'name') => React.ReactNode;
}>) {
    const { working, needsYou } = props;
    const idle = working === 0 && needsYou === 0;
    return (
        <View testID="home-hub.status" style={styles.line}>
            {idle ? <Text style={styles.text} numberOfLines={1}>{t('homeIndex.nothingRunning')}</Text> : null}
            {working > 0 ? (
                <View testID="home-hub.status.working" style={styles.fact}>
                    <SessionRowAttentionIndicator
                        indicator="working"
                        sessionId="home-status"
                        attentionState="working"
                    />
                    <Text style={styles.text}>{t('homeIndex.sessionsWorking', { count: working })}</Text>
                </View>
            ) : null}
            {needsYou > 0 ? (
                <View testID="home-hub.status.needsYou" style={styles.fact}>
                    <SessionRowAttentionIndicator
                        indicator="permission"
                        sessionId="home-status"
                        attentionState="permission_required"
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
        columnGap: 8,
        rowGap: 2,
        minHeight: 20,
    },
    fact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
        fontVariant: ['tabular-nums'],
    },
}));
