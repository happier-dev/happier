import * as React from 'react';
import Reanimated, { FadeIn } from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { motionTokens } from './motionTokens';

/**
 * One word or short phrase that changes in place ("Stops in 4:52" → "Stopped", "Updated by Claude just now"
 * → "by Claude 2m") with one short cross-fade (`guardMoment.wordCrossFadeMs`). A word that mounts already
 * showing simply shows; reduced motion changes it at once. A retained pane swapping one item's content for
 * another's uses the same fade at its own role's duration, and `immediate` when the swap came from the keyboard.
 */
export function WordCrossFade(props: Readonly<{
    wordKey: string;
    children: React.ReactNode;
    durationMs?: number;
    immediate?: boolean;
    style?: React.ComponentProps<typeof Reanimated.View>['style'];
}>) {
    const reducedMotion = useReducedMotionPreference();
    const firstKey = React.useRef(props.wordKey);
    const changed = React.useRef(false);
    if (props.wordKey !== firstKey.current) changed.current = true;
    return (
        <Reanimated.View key={props.wordKey} style={props.style}
            entering={changed.current && !reducedMotion && props.immediate !== true
                ? FadeIn.duration(props.durationMs ?? motionTokens.guardMoment.wordCrossFadeMs) : undefined}>
            {props.children}
        </Reanimated.View>
    );
}
