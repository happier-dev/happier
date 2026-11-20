import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import {
    resolveStepTransitionDirection,
    type StepTransitionDirection,
} from './resolveStepTransitionDirection';
import { SoftSlideTransitionFrame, type SoftSlideTransitionFrameProps } from './SoftSlideTransitionFrame';
import { motionTokens } from './motionTokens';

export type { StepTransitionDirection };

export type StepTransitionFrameProps = Readonly<{
    transitionKey: string | number;
    children: React.ReactNode;
    direction?: StepTransitionDirection;
    /** A same-screen status change clears and enters on the first-run notice timing. */
    notice?: boolean;
    style?: StyleProp<ViewStyle>;
    contentStyle?: StyleProp<ViewStyle>;
    /** Override the reduced-motion preference (test/escape hatch). */
    reducedMotion?: boolean;
    /** Views kept mounted (hidden) while not shown, see `SoftSlideTransitionFrame.retainedLayers`. */
    retainedLayers?: SoftSlideTransitionFrameProps['retainedLayers'];
    testID?: string;
}>;

export function StepTransitionFrame(props: StepTransitionFrameProps) {
    const detectedReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.notice === true || (props.reducedMotion ?? detectedReducedMotion);

    return (
        <SoftSlideTransitionFrame
            contentStyle={props.contentStyle}
            direction={props.direction ?? 'replace'}
            reducedMotion={reducedMotion}
            reducedMotionDurationMs={props.notice ? motionTokens.stepMotion.noticeCrossFadeMs : undefined}
            preset="routine"
            style={props.style}
            testID={props.testID}
            transitionKey={props.transitionKey}
            retainedLayers={props.retainedLayers}
        >
            {props.children}
        </SoftSlideTransitionFrame>
    );
}

// Re-export for convenience.
export { resolveStepTransitionDirection };
