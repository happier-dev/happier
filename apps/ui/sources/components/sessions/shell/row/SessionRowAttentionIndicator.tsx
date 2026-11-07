import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { StatusDot } from '@/components/ui/status/StatusDot';
import type {
    SessionRowAttentionIndicator as SessionRowAttentionIndicatorKind,
    SessionRowAttentionState,
} from './resolveSessionRowPresentation';
import { resolveSessionRowAttentionIndicatorColor } from './sessionRowAttentionColors';

/** Fills the indicator's 16 px slot, so the working mark reads at the scale of the row's agent icons. */
const DEFAULT_WORKING_SPINNER_SIZE = 16;
// Sized so an unseen-update or attention mark stays obvious on high-DPI screens (#732), while still
// fitting the 16 px slot beside the row's agent icons.
const STATUS_DOT_SIZE = 8;
const ATTENTION_STATUS_DOT_SIZE = 9;
const UNREAD_CENTER_SIZE = 5;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    unreadCenter: {
        position: 'absolute',
        left: (DEFAULT_WORKING_SPINNER_SIZE - UNREAD_CENTER_SIZE) / 2,
        top: (DEFAULT_WORKING_SPINNER_SIZE - UNREAD_CENTER_SIZE) / 2,
        width: UNREAD_CENTER_SIZE,
        height: UNREAD_CENTER_SIZE,
        borderRadius: UNREAD_CENTER_SIZE / 2,
        backgroundColor: theme.colors.text.link,
    },
    stateContainer: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export const SessionRowAttentionIndicator = React.memo(function SessionRowAttentionIndicator(props: Readonly<{
    indicator: SessionRowAttentionIndicatorKind;
    sessionId: string;
    attentionState: SessionRowAttentionState;
    accessibilityLabel?: string;
    hasUnreadMessages?: boolean;
    workingMode?: 'spinner' | 'pulse';
    workingSpinnerTone?: 'info' | 'neutral';
    animationEnabled?: boolean;
}>) {
    const { theme } = useUnistyles();

    if (props.indicator === 'none') {
        return null;
    }

    const color = resolveSessionRowAttentionIndicatorColor({
        indicator: props.indicator,
        theme,
        workingMode: props.workingMode,
        workingSpinnerTone: props.workingSpinnerTone,
    });

    const shouldRenderWorkingSpinner = props.indicator === 'working'
        && props.workingMode !== 'pulse';
    const shouldPulse = props.indicator === 'permission'
        || props.indicator === 'action'
        || props.indicator === 'failed'
        || (props.indicator === 'working' && props.workingMode === 'pulse');

    return (
        <View
            testID={`session-row-attention-indicator-${props.sessionId}`}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityRole={props.accessibilityLabel ? 'image' : undefined}
            style={stylesheet.container}
        >
            <View
                testID={`session-list-attention-indicator-${props.sessionId}-${props.attentionState}`}
                style={stylesheet.stateContainer}
            >
                {shouldRenderWorkingSpinner ? (
                    <ActivitySpinner
                        testID={`session-row-attention-indicator-spinner-${props.sessionId}`}
                        size={DEFAULT_WORKING_SPINNER_SIZE}
                        color={color}
                        animationEnabled={props.animationEnabled !== false}
                    />
                ) : (
                    <StatusDot
                        testID={`session-row-attention-indicator-dot-${props.sessionId}`}
                        color={color}
                        isPulsing={shouldPulse}
                        size={props.indicator === 'permission' || props.indicator === 'action' || props.indicator === 'failed' ? ATTENTION_STATUS_DOT_SIZE : STATUS_DOT_SIZE}
                        animationEnabled={props.animationEnabled !== false}
                    />
                )}
                {props.indicator === 'working' && props.hasUnreadMessages && (
                    <View
                        testID={`session-row-unread-center-${props.sessionId}`}
                        pointerEvents="none"
                        accessible={false}
                        style={stylesheet.unreadCenter}
                    />
                )}
            </View>
        </View>
    );
});
