import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusDot } from '@/components/ui/status/StatusDot';

import type {
    SessionRowAttentionIndicator as SessionRowAttentionIndicatorKind,
    SessionRowAttentionState,
} from './resolveSessionRowPresentation';

const WORKING_SPINNER_SIZE = 12;

const stylesheet = StyleSheet.create(() => ({
    container: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
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
    workingMode?: 'spinner' | 'pulse';
    workingSpinnerTone?: 'info' | 'neutral';
    animationEnabled?: boolean;
}>) {
    const { theme } = useUnistyles();

    if (props.indicator === 'none') {
        return null;
    }

    const color = (() => {
        switch (props.indicator) {
            case 'working':
                if (props.workingMode !== 'pulse' && props.workingSpinnerTone === 'neutral') {
                    return theme.colors.text.tertiary;
                }
                return theme.colors.state.info.foreground;
            case 'background':
                return theme.colors.state.info.foreground;
            case 'ready':
                return theme.colors.state.success.foreground;
            case 'failed':
                return theme.colors.state.danger.foreground;
            case 'unread':
                return theme.colors.text.link;
            case 'pending':
                return theme.colors.state.neutral.foreground;
            case 'permission':
            case 'action':
                return theme.colors.state.warning.foreground;
        }
    })();

    const shouldRenderWorkingSpinner = props.indicator === 'working' && props.workingMode !== 'pulse';
    const shouldPulse =
        props.indicator === 'permission'
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
                        size={WORKING_SPINNER_SIZE}
                        color={color}
                        animationEnabled={props.animationEnabled !== false}
                    />
                ) : (
                    <StatusDot
                        testID={`session-row-attention-indicator-dot-${props.sessionId}`}
                        color={color}
                        isPulsing={shouldPulse}
                        size={props.indicator === 'permission' || props.indicator === 'action' || props.indicator === 'failed' ? 7 : 6}
                        animationEnabled={props.animationEnabled !== false}
                    />
                )}
            </View>
        </View>
    );
});
