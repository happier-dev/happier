import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { formatScmHistoryTimestamp, formatScmHistoryTimestampAccessibilityLabel } from '@/scm/history/historyPresentation';
import { t } from '@/text';

import type { CodeEntryHistoryState } from './codeEntryHistoryPresentation';

/**
 * A Code folder row's history columns (lab p-code BROWSE): the latest commit subject touching the
 * entry, then when. Their room is reserved from the first paint, so the rows never move when the
 * batch for the visible rows answers; a pending entry holds a quiet bar in each column.
 *
 * `layout="columns"` is the desktop table (subject and time as columns beside the name);
 * `"time"` and `"subject"` are the phone row's two halves (time at the end, subject under the name).
 */
export const CodeEntryHistoryCells = React.memo(function CodeEntryHistoryCells(props: Readonly<{
    testID?: string;
    state: CodeEntryHistoryState;
    layout: 'columns' | 'time' | 'subject';
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const state = props.state;
    const pending = state.kind === 'pending';
    const commit = state.kind === 'commit' ? state.commit : null;

    const subject = pending ? (
        <HappierSkeletonBlock width="46%" height={8} radius={4} color={theme.colors.surface.pressedOverlay} reducedMotion={reducedMotion} />
    ) : commit ? (
        <Text numberOfLines={1} style={styles.subject}>{commit.subject}</Text>
    ) : state.kind === 'none' ? (
        <Text numberOfLines={1} style={styles.none}>{t('projects.code.noEntryCommit')}</Text>
    ) : null;
    const time = pending ? (
        <HappierSkeletonBlock width={44} height={8} radius={4} color={theme.colors.surface.pressedOverlay} reducedMotion={reducedMotion} />
    ) : commit ? (
        <Text
            numberOfLines={1}
            accessibilityLabel={formatScmHistoryTimestampAccessibilityLabel(commit.committedAt)}
            style={styles.time}
        >
            {formatScmHistoryTimestamp(commit.committedAt)}
        </Text>
    ) : null;

    if (props.layout === 'subject') {
        return subject ? <View testID={props.testID} style={styles.subjectLine}>{subject}</View> : null;
    }
    if (props.layout === 'time') {
        return <View testID={props.testID} style={styles.timeCell}>{time}</View>;
    }
    return (
        <View testID={props.testID} style={styles.columns} aria-busy={pending || undefined}>
            <View style={styles.subjectCell}>{subject}</View>
            <View style={styles.timeCell}>{time}</View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    // The name column keeps the first third of the row (lab `minmax(150px, 34%)`); the commit columns
    // take the rest at a fixed share, so every row's subject starts on one line.
    columns: {
        width: '64%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
    subjectCell: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
    },
    subjectLine: {
        marginTop: 1,
    },
    timeCell: {
        width: 76,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    subject: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    none: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
    },
    time: {
        ...Typography.rowMeta(),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
        textAlign: 'right',
    },
}));
