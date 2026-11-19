import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { WorkflowRunStrip } from './workflowRunStrip';

/**
 * A workflow's recent runs, drawn as one non-interactive element (scene 8, owner 11-19): one slim 3 × 10 px bar per
 * run, oldest to newest, quiet ink when healthy; a failed run takes the danger ink and a run that needs you the
 * warning ink. Every row, table cell and card draws this one strip. Its accessible name states the outcomes.
 */
export const WorkflowRunStripView = React.memo(function WorkflowRunStripView(props: Readonly<{
    strip: WorkflowRunStrip;
    testID?: string;
}>) {
    return (
        <View
            testID={props.testID}
            style={styles.strip}
            accessible
            accessibilityRole="image"
            accessibilityLabel={props.strip.accessibilityLabel}
        >
            {props.strip.cells.map((cell, index) => (
                <View key={cell.runId ?? `empty-${index}`} style={styles.slot}>
                    <View style={styles[cell.kind]} />
                </View>
            ))}
        </View>
    );
});

const BAR_WIDTH = 3;
const BAR_HEIGHT = 10;

const bar = { width: BAR_WIDTH, height: BAR_HEIGHT, borderRadius: BAR_WIDTH / 2 } as const;

const styles = StyleSheet.create((theme) => ({
    strip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
        height: BAR_HEIGHT,
        flexShrink: 0,
    },
    slot: bar,
    // An empty place is a whisper of ink (the strong border weight), so the strip reads as one object of eight places.
    none: { ...bar, backgroundColor: theme.colors.border.strong },
    ok: { ...bar, backgroundColor: theme.colors.text.tertiary },
    failed: { ...bar, backgroundColor: theme.colors.state.danger.foreground },
    needsYou: { ...bar, backgroundColor: theme.colors.state.warning.foreground },
}));
