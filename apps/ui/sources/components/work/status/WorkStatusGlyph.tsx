import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusDot } from '@/components/ui/status/StatusDot';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { WORK_STATUS_WORKING_SPINNER_VARIANT, workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';

/**
 * The row's status slot (lab `clstatus`): a 14 px glyph column, reserved so glyphs, words and times share one
 * right edge. Working is the thin activity mark, a little smaller than the glyphs so it reads as motion, not state.
 */
const STATUS_SLOT_SIZE = 14;
const WORKING_SPINNER_SIZE = 12;
const UNREAD_CENTER_SIZE = 3;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: STATUS_SLOT_SIZE,
        height: STATUS_SLOT_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    unreadCenter: {
        position: 'absolute',
        left: (STATUS_SLOT_SIZE - UNREAD_CENTER_SIZE) / 2,
        top: (STATUS_SLOT_SIZE - UNREAD_CENTER_SIZE) / 2,
        width: UNREAD_CENTER_SIZE,
        height: UNREAD_CENTER_SIZE,
        borderRadius: UNREAD_CENTER_SIZE / 2,
        backgroundColor: theme.colors.text.link,
    },
    stateContainer: {
        width: STATUS_SLOT_SIZE,
        height: STATUS_SLOT_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/**
 * Happier core's binding of a work status into a list row's status slot (lab `clstatus`): the shared glyph
 * (`HappierStatusDot`'s status glyphs) in its tone, or the host's activity spinner while the work runs. The
 * state, tone and glyph come from the one Work adapter (`resolveWorkStatusTone`); this draws, it never decides.
 * Sessions, Runs, Workflow definitions and Discussions all draw their status through it.
 */
export const WorkStatusGlyph = React.memo(function WorkStatusGlyph(props: Readonly<{
    status: WorkStatusPresentation;
    /** Suffix of the slot's test ids (`session-row-attention-indicator-<suffix>`, kept for existing selectors). */
    testIDSuffix: string;
    hasUnreadMessages?: boolean;
    animationEnabled?: boolean;
}>) {
    const { theme } = useUnistyles();

    if (!props.status.glyph) {
        return null;
    }

    const color = workStatusGlyphColor(theme.colors, props.status.tone);
    const working = props.status.bucket === 'working';

    return (
        <View
            testID={`session-row-attention-indicator-${props.testIDSuffix}`}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={stylesheet.container}
        >
            <View
                testID={`session-list-attention-indicator-${props.testIDSuffix}-${props.status.state}`}
                style={stylesheet.stateContainer}
            >
                {working ? (
                    <ActivitySpinner
                        testID={`session-row-attention-indicator-spinner-${props.testIDSuffix}`}
                        size={WORKING_SPINNER_SIZE}
                        color={color}
                        animationEnabled={props.animationEnabled !== false}
                        variant={WORK_STATUS_WORKING_SPINNER_VARIANT}
                    />
                ) : (
                    <StatusDot
                        testID={`session-row-attention-indicator-dot-${props.testIDSuffix}`}
                        color={color}
                        glyph={props.status.glyph}
                        isPulsing={false}
                        // A glyph fills the slot; the unread dot keeps its small size.
                        size={props.status.glyph === 'new' ? 6 : STATUS_SLOT_SIZE}
                        animationEnabled={props.animationEnabled !== false}
                    />
                )}
                {working && props.hasUnreadMessages && (
                    <View
                        testID={`session-row-unread-center-${props.testIDSuffix}`}
                        pointerEvents="none"
                        accessible={false}
                        style={stylesheet.unreadCenter}
                    />
                )}
            </View>
        </View>
    );
});
