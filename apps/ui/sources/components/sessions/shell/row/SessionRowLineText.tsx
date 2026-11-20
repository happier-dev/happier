import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { SessionRowActivityTime } from './SessionRowActivityTime';

const formatNoteAge = (age: string) => ` · ${t('sessionWork.list.noteAge', { age })}`;

/**
 * One text on a Session row's detail line (lab ideas-1118-shell scene 7): the now line, an external Session's own
 * line, the branch, the Machine, a plugin's context or the Project. The now line reads in secondary ink; quiet details, and a note that waits while
 * nothing moves, in tertiary. A note older than the latest turn end says its own age on the shared clock, so a
 * minute turning wakes only that leaf. The row's accessible label carries the same words.
 */
export const SessionRowLineText = React.memo(function SessionRowLineText(props: Readonly<{
    children: string;
    tone: 'secondary' | 'quiet';
    icon?: IconName;
    /** When set, the note's own age follows the text. */
    ageAt?: number | null;
    /** A leading context (the Project) that the line's text follows after a dot. */
    separated?: boolean;
    /** A later detail of the same text (the Machine after the branch): a dot first. */
    afterDot?: boolean;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const color = props.tone === 'quiet' ? theme.colors.text.tertiary : theme.colors.text.secondary;
    return (
        <View testID={props.testID} style={[styles.segment, props.separated ? styles.leadingSegment : null]}>
            {props.afterDot ? <Text style={styles.age}>{' ·'}</Text> : null}
            {props.icon ? <Icon name={props.icon} size={12} color={theme.colors.text.tertiary} /> : null}
            <Text numberOfLines={1} style={[styles.text, { color }]}>{props.children}</Text>
            {typeof props.ageAt === 'number' ? (
                <SessionRowActivityTime activityAt={props.ageAt} format={formatNoteAge} style={styles.age} />
            ) : null}
            {props.separated ? <Text style={styles.age}>{' · '}</Text> : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    segment: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        gap: theme.space.s4,
    },
    // The Project leads the line and keeps its name whole while the work after it yields first.
    leadingSegment: {
        flexShrink: 0,
        maxWidth: '45%',
        gap: 0,
    },
    text: {
        ...Typography.variant('meta'),
        flexShrink: 1,
        minWidth: 0,
    },
    age: {
        ...Typography.variant('meta'),
        flexShrink: 0,
        color: theme.colors.text.tertiary,
    },
}));
