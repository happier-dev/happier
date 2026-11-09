import * as React from 'react';
import { Animated, Platform, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useVoiceReadAloudMessagePhase } from '@/components/voice/presence/useVoiceReadAloudMessagePhase';
import { t } from '@/text';

import {
    TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS,
    TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS,
    markTranscriptJumpHighlightPainted,
    useTranscriptJumpHighlight,
} from './transcriptJumpHighlightStore';

export const TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID = 'transcript-jump-highlight';

const TRANSCRIPT_JUMP_HIGHLIGHT_POP_MS = 260;
const TRANSCRIPT_JUMP_HIGHLIGHT_POP_SCALE = 1.012;

/**
 * Jump-landing attention treatment for the transcript element the user actually
 * jumped to — the user bubble, the agent block, the tool row — instead of the
 * full-width row that centres it (which washed the gutters too).
 *
 * Only the absolutely-positioned ring animates (opacity plus a short scale pop),
 * so the landing position cannot shift: this fires immediately after a jump lands
 * and any layout change would corrupt it. Keeping the animation inside the ring
 * also keeps every non-highlighted row free of animation state and preference
 * subscriptions. The ring inherits the element's own radius and paints behind its
 * content. Reduced motion keeps a static ring for the full duration: no pop, no fade.
 *
 * Jump timing stays owned by `transcriptJumpHighlightStore`. Read-aloud uses
 * the same treatment without animation, for the speech owner's active row.
 */
export function TranscriptJumpAttention(props: Readonly<{
    sessionAddress: SessionAddress | null;
    routeMessageId?: string | null;
    seq?: number | null;
    filePath?: string | null;
    radius: number;
    style?: StyleProp<ViewStyle>;
    viewProps?: ViewProps;
    viewRef?: React.Ref<View>;
    children: React.ReactNode;
}>): React.ReactElement {
    const token = useTranscriptJumpHighlight({
        sessionAddress: props.sessionAddress,
        routeMessageId: props.routeMessageId ?? null,
        seq: props.seq ?? null,
        filePath: props.filePath ?? null,
    });
    const readAloud = useVoiceReadAloudMessagePhase(props.filePath ? null : props.sessionAddress, props.routeMessageId ?? null);
    return (
        <View {...(props.viewProps ?? null)} ref={props.viewRef} style={props.style}>
            {readAloud !== 'idle' ? (
                <View pointerEvents="none" accessible
                    accessibilityLabel={readAloud === 'preparing' ? t('voicePresence.readAloud.preparing') : t('voicePresence.readAloud.speaking')}
                    style={[styles.ring, { borderRadius: props.radius }]}
                    testID="transcript-read-aloud-highlight" />
            ) : token != null ? <TranscriptJumpAttentionRing key={token} token={token} radius={props.radius} /> : null}
            {props.children}
        </View>
    );
}

const TranscriptJumpAttentionRing = React.memo(function TranscriptJumpAttentionRing(props: Readonly<{ token: number; radius: number }>) {
    const reducedMotion = useReducedMotionPreference();
    // The cue's duration starts once this row has painted it, never at the jump's report.
    React.useEffect(() => {
        const frame = requestAnimationFrame(() => markTranscriptJumpHighlightPainted(props.token));
        return () => cancelAnimationFrame(frame);
    }, [props.token]);
    const opacityRef = React.useRef<Animated.Value | null>(null);
    const scaleRef = React.useRef<Animated.Value | null>(null);
    if (opacityRef.current == null) {
        opacityRef.current = new Animated.Value(1);
    }
    if (scaleRef.current == null) {
        scaleRef.current = new Animated.Value(1);
    }
    const opacity = opacityRef.current;
    const scale = scaleRef.current;

    React.useEffect(() => {
        if (reducedMotion) {
            opacity.setValue(1);
            scale.setValue(1);
            return;
        }
        const fade = Animated.timing(opacity, {
            toValue: 0,
            duration: TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS,
            delay: Math.max(0, TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS - TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS),
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        });
        const halfPopMs = Math.round(TRANSCRIPT_JUMP_HIGHLIGHT_POP_MS / 2);
        const settle = Animated.timing(scale, {
            toValue: 1,
            duration: halfPopMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        });
        const pop = Animated.timing(scale, {
            toValue: TRANSCRIPT_JUMP_HIGHLIGHT_POP_SCALE,
            duration: halfPopMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        });
        fade.start();
        pop.start((result?: { finished?: boolean }) => {
            if (result?.finished !== false) settle.start();
        });
        return () => {
            fade.stop();
            pop.stop();
            settle.stop();
        };
    }, [opacity, reducedMotion, scale]);

    return (
        <Animated.View
            pointerEvents="none"
            style={[styles.ring, { borderRadius: props.radius, opacity, transform: [{ scale }] }]}
            testID={TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    ring: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderWidth: 1.5,
        borderColor: theme.colors.state.active.foreground,
        backgroundColor: theme.colors.state.active.background,
    },
}));
