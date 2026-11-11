import * as React from 'react';
import { Animated, View } from 'react-native';
import { ComposerKeyboardScrollInset } from '@/components/sessions/keyboardAvoidance';
import { TRANSCRIPT_TOP_GUTTER_PX } from '@/components/sessions/transcript/_constants';
import { useTranscriptFindClearance } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { TranscriptSessionActivityLine } from './TranscriptSessionActivityLine';
import { SessionReportsChip } from './SessionReportsChip';
import { ProjectSetupSessionReturn } from '@/components/projects/projectSetup/ProjectSetupReturn';
import { ProjectSetupSessionReviews } from '@/components/projects/projectSetup/ProjectSetupSessionReview';

export const ListHeader = React.memo(() => {
    // While the inline Find capsule floats over the transcript, the first row starts below it. The band
    // opens and closes with the capsule (its overlay popover timing), not as a jump; at once under
    // reduced motion (a height cannot cross-fade).
    const findClearance = useTranscriptFindClearance();
    const target = Math.max(TRANSCRIPT_TOP_GUTTER_PX, findClearance);
    const reducedMotion = useReducedMotionPreference();
    const height = React.useRef(new Animated.Value(target)).current;
    const previous = React.useRef(target);
    React.useLayoutEffect(() => {
        if (previous.current === target) return;
        const opening = target > previous.current;
        previous.current = target;
        if (reducedMotion) { height.setValue(target); return; }
        const animation = Animated.timing(height, {
            toValue: target,
            duration: opening ? motionTokens.overlay.popover.enterMs : motionTokens.overlay.popover.exitMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: false,
        });
        animation.start();
        return () => animation.stop();
    }, [height, reducedMotion, target]);
    return (
        <View>
            <Animated.View testID="transcript-top-gutter" style={{ height }} />
        </View>
    );
});

export const ChatListFooterWithKeyboardInset = React.memo((props: {
    sessionId: string;
    serverId?: string | null;
    showToolCalls?: boolean;
    onComposerInsetHeightChange?: (height: number) => void;
}) => {
    return (
        <View>
            {props.showToolCalls === false && props.serverId ? (
                <TranscriptSessionActivityLine sessionId={props.sessionId} serverId={props.serverId} />
            ) : null}
            {/* The Sessions this Session started: one chip into the Agents destination (lab `b-launch`). */}
            <SessionReportsChip sessionId={props.sessionId} serverId={props.serverId} />
            {/* A finite command this Session's agent started that is held on setup consent asks here (lab `s-setup` ASK). */}
            <ProjectSetupSessionReviews sessionId={props.sessionId} serverId={props.serverId} />
            {/* A Session started from Project setup ends with its way back (lab `s-setup` DONE). */}
            <ProjectSetupSessionReturn sessionId={props.sessionId} serverId={props.serverId} />
            <ComposerKeyboardScrollInset
                testID="transcript-composer-keyboard-inset"
                onHeightChange={props.onComposerInsetHeightChange}
            />
        </View>
    );
});
