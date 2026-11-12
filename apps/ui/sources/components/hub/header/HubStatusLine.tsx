import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useActivityOverviewSummary } from '@/activity/source/useActivityOverview';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { Text } from '@/components/ui/text/Text';
import { useSharedInboxSummary } from '@/hooks/inbox/useInboxSummary';
import { t } from '@/text';

/**
 * Home's one line about the present, under the greeting: "◌ 2 sessions working · ● 8 in your Inbox",
 * then which Home this is. What waits for the person is the Inbox's own count (the rail badge's, so
 * approvals and every other Inbox item are in it), never a second classification, and it opens the
 * Inbox. It always holds one line, so the page below never moves as sessions start and stop. It is a
 * leaf: a session or Inbox change re-renders this line only.
 */
export const HubStatusLine = React.memo(function HubStatusLine(props: Readonly<{
    home: (detail: 'full' | 'name') => React.ReactNode;
    inboxPresented?: boolean;
}>) {
    const summary = useActivityOverviewSummary();
    const inbox = useSharedInboxSummary();
    const router = useRouter();
    const openInbox = React.useCallback(() => router.push('/inbox'), [router]);
    return <HubStatusLineView working={summary.workingCount} inbox={inbox.count} inboxPresented={props.inboxPresented} onOpenInbox={openInbox} isDataReady={summary.isDataReady} home={props.home} />;
});

/**
 * The line as drawn for given counts (the `/dev/home` fixture draws it too): what is working and
 * what waits in the Inbox, then which Home this is. With nothing running and nothing waiting it says
 * so, then the Home and where it lives in full (J1). An Inbox count still being read is left out.
 */
export function HubStatusLineView(props: Readonly<{
    working: number;
    /** The Inbox's count; `null` while it is still being read. */
    inbox: number | null;
    /** The attention section or open brief already presents the Inbox count. */
    inboxPresented?: boolean;
    onOpenInbox?: () => void;
    isDataReady?: boolean;
    home: (detail: 'full' | 'name') => React.ReactNode;
}>) {
    const { working } = props;
    const inbox = props.inbox ?? 0;
    const idle = working === 0 && inbox === 0;
    const inboxLabel = t('homeIndex.inboxWaiting', { count: inbox });
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
            {inbox > 0 && !props.inboxPresented ? (
                <HappierPressable
                    testID="home-hub.status.inbox"
                    accessibilityRole="link"
                    accessibilityLabel={inboxLabel}
                    onPress={props.onOpenInbox}
                    style={styles.fact}
                >
                    <WorkStatusGlyph
                        status={{ state: 'needs_you', bucket: 'needs_you', tone: 'attention', word: '', attentionType: null, glyph: 'attention' }}
                        testIDSuffix="home-status"
                        animationEnabled={false}
                    />
                    <Text style={styles.link}>{inboxLabel}</Text>
                </HappierPressable>
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
    // The one fact here that goes somewhere: the same words, in the stronger ink a link takes on this line.
    link: {
        color: theme.colors.text.primary,
        ...happierPageTextMetrics('pageDescription'),
        fontVariant: ['tabular-nums'],
    },
}));
