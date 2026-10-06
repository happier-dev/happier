import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { WorkflowRunStrip } from './workflowRunStrip';

/**
 * A saved workflow's recent runs, drawn as one non-interactive element (07 S2, UX-14): a quiet bar
 * per run, oldest to newest, neutral when healthy. A failed run is a shorter, tinted bar (a notch) and
 * a run that needs you is a tinted dot, so both keep a shape of their own under forced colours. Its
 * accessible name states the outcomes.
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
const BAR_HEIGHT = 12;

const styles = StyleSheet.create((theme) => ({
    strip: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: theme.margins.xs,
        height: BAR_HEIGHT,
    },
    slot: {
        width: BAR_WIDTH,
        height: BAR_HEIGHT,
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    none: {
        width: BAR_WIDTH,
        height: BAR_HEIGHT,
        borderRadius: BAR_WIDTH / 2,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    ok: {
        width: BAR_WIDTH,
        height: BAR_HEIGHT,
        borderRadius: BAR_WIDTH / 2,
        backgroundColor: theme.colors.text.tertiary,
    },
    failed: {
        width: BAR_WIDTH,
        height: BAR_HEIGHT - 4,
        borderRadius: BAR_WIDTH / 2,
        backgroundColor: theme.colors.state.danger.foreground,
    },
    needsYou: {
        width: BAR_WIDTH + 2,
        height: BAR_WIDTH + 2,
        borderRadius: (BAR_WIDTH + 2) / 2,
        backgroundColor: theme.colors.state.warning.foreground,
    },
}));
