import * as React from 'react';
import { Animated, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import {
    TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS,
    TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS,
    useTranscriptJumpHighlight,
    type TranscriptJumpHighlightRowIdentity,
} from './transcriptJumpHighlightStore';

export const TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID = 'transcript-jump-highlight';

/**
 * Jump-landing highlight wash for a transcript row (plan: "Jump Highlight").
 * Renders nothing until the highlight store marks this row as the landed jump
 * target, then shows a subtle themed background wash that fades out. Absolute
 * overlay only — no layout shift. Reduced motion renders the wash statically
 * for the full duration; the store expiry removes it without a fade.
 */
export const TranscriptJumpHighlightOverlay = React.memo(function TranscriptJumpHighlightOverlay(
    props: TranscriptJumpHighlightRowIdentity,
) {
    const token = useTranscriptJumpHighlight(props);
    if (token == null) return null;
    return <TranscriptJumpHighlightWash key={token} />;
});

const TranscriptJumpHighlightWash = React.memo(function TranscriptJumpHighlightWash() {
    const reducedMotion = useReducedMotionPreference();
    const opacityRef = React.useRef<Animated.Value | null>(null);
    if (opacityRef.current == null) {
        opacityRef.current = new Animated.Value(1);
    }
    const opacity = opacityRef.current;

    React.useEffect(() => {
        if (reducedMotion) {
            opacity.setValue(1);
            return;
        }
        const animation = Animated.timing(opacity, {
            toValue: 0,
            duration: TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS,
            delay: Math.max(0, TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS - TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS),
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        });
        animation.start();
        return () => {
            animation.stop();
        };
    }, [opacity, reducedMotion]);

    return (
        <Animated.View
            pointerEvents="none"
            style={[styles.wash, { opacity }]}
            testID={TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    wash: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: theme.colors.state.active.background,
    },
}));
