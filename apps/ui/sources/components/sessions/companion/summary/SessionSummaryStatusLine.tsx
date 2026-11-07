import * as React from 'react';
import { View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';

const stylesheet = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, minHeight: 26 },
    title: {  color: theme.colors.text.primary,
        ...Typography.variant('heading'),  flexShrink: 1 },
    // Under the title, on the same start as the card's sentence line (`SessionSummaryCard` what).
    stateRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, marginStart: 23 },
    words: { color: theme.colors.text.primary, ...Typography.variant('body'), flexShrink: 1 },
    timer: {  ...Typography.tabular(), color: theme.colors.text.secondary, ...Typography.variant('body') },
    grow: { flex: 1 },
}));

function formatElapsedClock(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const pad = (value: number) => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

/**
 * The one ticking leaf: the summary card's status line and the transcript's activity line both show a
 * turn's elapsed time through it, each in its own ink; neither owns a timer.
 */
export const SessionElapsedClock = React.memo(function SessionElapsedClock(props: Readonly<{
    sinceMs: number;
    testID: string;
    style?: StyleProp<TextStyle>;
}>) {
    const seconds = useElapsedTime(props.sinceMs);
    return <Text testID={props.testID} style={props.style ?? stylesheet.timer}>{formatElapsedClock(seconds)}</Text>;
});

/** Presentation only: every word and start fact is supplied by the awareness owner. */
export const SessionSummaryStatusLine = React.memo(function SessionSummaryStatusLine(props: Readonly<{
    /** What the card is: its identity leads, so a state never stands in as its title. */
    title: string;
    /** The state in words, on the line beneath the title (none while the owner states none). */
    words: string | null;
    agentId: string | null;
    sinceMs: number | null;
    testID: string;
    headerAccessory?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    return <>
        <View style={stylesheet.row}>
            {props.agentId ? <AgentIcon agentId={props.agentId} size={15} />
                : <Icon name="stack" size={15} color={theme.colors.text.tertiary} />}
            <Text testID={`${props.testID}-title`} style={stylesheet.title} numberOfLines={1} accessibilityRole="header">
                {props.title}
            </Text>
            <View style={stylesheet.grow} />
            {props.headerAccessory}
        </View>
        {props.words !== null || props.sinceMs !== null ? <View style={stylesheet.stateRow}>
            {props.words !== null
                ? <Text testID={`${props.testID}-status`} style={stylesheet.words} numberOfLines={1}>{props.words}</Text> : null}
            {props.sinceMs !== null ? <SessionElapsedClock sinceMs={props.sinceMs} testID={`${props.testID}-timer`} /> : null}
        </View> : null}
    </>;
});
