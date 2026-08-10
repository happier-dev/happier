import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AGENT_ROW_MIN_HEIGHT_PX, AGENT_STATUS_COLUMN_PX } from '../row/agentRowMetrics';

/**
 * Placeholder rows shown while the roster is hydrating and nothing is on screen yet.
 *
 * **The count is never guessed.** A skeleton is a promise about the structure that is about to
 * arrive; three bars invented because three looks nice is a promise the data did not make. The
 * caller derives `count` from the activity headline, and a caller that does not know renders no
 * skeleton at all rather than a decorative one.
 *
 * Deliberately still: a shimmer here would be the only moving thing on a screen whose whole point
 * is that motion means work is happening. It also needs no reduced-motion branch, because there is
 * nothing to reduce.
 */

/** Beyond four, a skeleton stops describing structure and starts being a loading screen. */
export const AGENT_ACTIVITY_SKELETON_MAX_ROWS = 4;

/** Bar widths cycle so the placeholder reads as titles of different lengths, not a table. */
const TITLE_WIDTHS = ['62%', '46%', '71%', '54%'] as const;

export type AgentActivitySkeletonProps = Readonly<{
    /** How many rows are expected. Clamped to {@link AGENT_ACTIVITY_SKELETON_MAX_ROWS}. */
    count: number;
    testID?: string;
}>;

export function AgentActivitySkeleton(props: AgentActivitySkeletonProps): React.ReactElement | null {
    const rows = Math.min(Math.max(Math.floor(props.count), 0), AGENT_ACTIVITY_SKELETON_MAX_ROWS);
    if (rows === 0) return null;

    return (
        <View
            testID={props.testID}
            style={styles.container}
            // Placeholder chrome is not content; assistive technology should hear the roster when
            // it arrives, not a description of its scaffolding.
            aria-hidden={true}
            accessibilityElementsHidden={true}
            importantForAccessibility="no-hide-descendants"
        >
            {Array.from({ length: rows }, (_, index) => (
                <View
                    key={`agent-activity-skeleton-${index}`}
                    testID={props.testID ? `${props.testID}:row` : undefined}
                    style={styles.row}
                >
                    <View style={styles.statusColumn} />
                    <View
                        style={[
                            styles.title,
                            { width: TITLE_WIDTHS[index % TITLE_WIDTHS.length]! },
                        ]}
                    />
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
    },
    row: {
        // The same height a real row will take, so the roster arriving does not shift the pane.
        minHeight: AGENT_ROW_MIN_HEIGHT_PX.withActions,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 12,
    },
    statusColumn: {
        width: AGENT_STATUS_COLUMN_PX.comfortable,
        height: AGENT_STATUS_COLUMN_PX.comfortable,
        borderRadius: AGENT_STATUS_COLUMN_PX.comfortable / 2,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    title: {
        height: 12,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
}));
