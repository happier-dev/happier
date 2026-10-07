import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusDot } from '@/components/ui/status/StatusDot';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';

import type {
    SessionRowAttentionIndicator as SessionRowAttentionIndicatorKind,
    SessionRowAttentionState,
} from './resolveSessionRowPresentation';

/** Fills the indicator's 16 px slot, so the working mark reads at the scale of the row's agent icons. */
const WORKING_SPINNER_SIZE = 16;

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

/**
 * Each marker in the shared status vocabulary: needs-you (an attention ask, a permission, an action)
 * is the attention amber, a failure is rose, and everything else — working (a moving mark), ready,
 * unread, pending, kept in attention — is the quiet ink. Blue stays reserved for focus and links.
 */
const INDICATOR_TONE: Readonly<Record<Exclude<SessionRowAttentionIndicatorKind, 'none'>, WorkStatusTone>> = Object.freeze({
    working: 'neutral',
    ready: 'neutral',
    unread: 'neutral',
    pending: 'neutral',
    // Attention standing explains a row that is only in the band because the person put it there; it
    // takes the same muted ink as the sentence beside it, so the line reads as one quiet utterance.
    standing: 'neutral',
    attention: 'attention',
    permission: 'attention',
    action: 'attention',
    failed: 'danger',
});

export const SessionRowAttentionIndicator = React.memo(function SessionRowAttentionIndicator(props: Readonly<{
    indicator: SessionRowAttentionIndicatorKind;
    sessionId: string;
    attentionState: SessionRowAttentionState;
    workingMode?: 'spinner' | 'pulse';
    animationEnabled?: boolean;
}>) {
    const { theme } = useUnistyles();

    if (props.indicator === 'none') {
        return null;
    }

    const color = workStatusGlyphColor(theme.colors, INDICATOR_TONE[props.indicator]);

    const shouldRenderWorkingSpinner = props.indicator === 'working' && props.workingMode !== 'pulse';
    const shouldPulse =
        props.indicator === 'permission'
        || props.indicator === 'action'
        || props.indicator === 'failed'
        || (props.indicator === 'working' && props.workingMode === 'pulse');

    return (
        <View
            testID={`session-row-attention-indicator-${props.sessionId}`}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
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
