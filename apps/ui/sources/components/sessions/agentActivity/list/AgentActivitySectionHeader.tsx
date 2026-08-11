import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { AgentActivitySectionId } from './agentActivitySectionModel';

/**
 * A section title inside the one list.
 *
 * It is a row, not a container: `WORKING` names the rows under it the way a heading names a
 * paragraph, and the rows remain siblings of every other row in the list. That is what lets an
 * agent that finishes move from one heading to another instead of being unmounted and rebuilt.
 *
 * The count is plain tabular text, not a pill. The pane had four hand-rolled count pills before
 * this; a number sitting quietly in the same right-hand column as the elapsed times reads faster
 * and adds no chrome.
 */

const SECTION_TITLE_KEYS = {
    working: 'session.agentActivity.section.working',
    finished: 'session.agentActivity.section.finished',
} as const satisfies Record<AgentActivitySectionId, string>;

export type AgentActivitySectionHeaderProps = Readonly<{
    sectionId: AgentActivitySectionId;
    /** Entries in the section before any cap, so a capped FINISHED still says how many there are. */
    count: number;
    /**
     * The density of the rows this heading names.
     *
     * The heading used to hardcode `16` while its rows paid `Item`'s density-derived padding, so a
     * heading and the rows under it started at two different x-positions — the scan axis the row
     * geometry exists to create, broken by the one element above it.
     */
    density?: ResolvedItemDensity;
    testID?: string;
}>;

export function AgentActivitySectionHeader(
    props: AgentActivitySectionHeaderProps,
): React.ReactElement {
    const title = t(SECTION_TITLE_KEYS[props.sectionId]);
    const density = useResolvedItemDensity(props.density);

    return (
        <View
            testID={props.testID}
            style={[styles.container, { paddingHorizontal: ITEM_ROW_PADDING_HORIZONTAL[density] }]}
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
