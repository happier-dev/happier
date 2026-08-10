import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { AgentActivitySectionId } from './agentActivitySectionModel';

/**
 * A section title inside the one list.
 *
 * It is a row, not a container: `NEEDS YOU` names the rows under it the way a heading names a
 * paragraph, and the rows remain siblings of every other row in the list. That is what lets an
 * agent that finishes move from one heading to another instead of being unmounted and rebuilt.
 *
 * The count is plain tabular text, not a pill. The pane had four hand-rolled count pills before
 * this; a number sitting quietly in the same right-hand column as the elapsed times reads faster
 * and adds no chrome.
 */

const SECTION_TITLE_KEYS = {
    needsYou: 'session.agentActivity.section.needsYou',
    working: 'session.agentActivity.section.working',
    finished: 'session.agentActivity.section.finished',
} as const satisfies Record<AgentActivitySectionId, string>;

export type AgentActivitySectionHeaderProps = Readonly<{
    sectionId: AgentActivitySectionId;
    /** Entries in the section before any cap, so a capped FINISHED still says how many there are. */
    count: number;
    testID?: string;
}>;

export function AgentActivitySectionHeader(
    props: AgentActivitySectionHeaderProps,
): React.ReactElement {
    const title = t(SECTION_TITLE_KEYS[props.sectionId]);

    return (
        <View
            testID={props.testID}
            style={styles.container}
            accessibilityRole="header"
        >
            <Eyebrow style={styles.title}>{title}</Eyebrow>
            <Text style={styles.count}>{props.count}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 6,
    },
    title: {
        // Uppercased here rather than in the translations: casing is a visual decision and several
        // locales have no case at all.
        textTransform: 'uppercase',
    },
    count: {
        ...Typography.timestamp(),
        color: theme.colors.text.secondary,
    },
}));
