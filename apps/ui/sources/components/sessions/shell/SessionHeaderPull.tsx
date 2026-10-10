import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, {
    useAnimatedReaction,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { Text } from '@/components/ui/text/Text';
import { hapticsLight, hapticsSelection } from '@/components/ui/theme/haptics';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import {
    SESSION_HEADER_PULL_ARM_PX,
    resolveSessionHeaderPullFrame,
    resolveSessionHeaderPullRelease,
} from './sessionHeaderPullGesture';

/**
 * The session-title pull (lab round 2b, frame P): press the header's identity or title, drag down,
 * let go past the threshold and All tabs opens.
 *
 * Two pieces because two things move and only one may be touched: the HOST is the whole header band
 * (it follows the finger and owns the hint in the gap that opens above it), the TARGET is only the
 * identity and title, so the back chevron and the action buttons keep their presses and never start
 * a pull. Phone native only, like the bar's gestures: on the web the browser owns overscroll.
 */

type PullContext = Readonly<{ gesture: GestureType | null }>;
const SessionHeaderPullContext = React.createContext<PullContext>({ gesture: null });

const styles = StyleSheet.create((theme) => ({
    hint: {
        position: 'absolute',
        alignSelf: 'center',
        height: 30,
        paddingLeft: 10,
        paddingRight: 12,
        borderRadius: 15,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: theme.colors.surface.elevated,
        zIndex: 1,
    },
    hintText: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    hintTextReady: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));

/** "Pull for all tabs" / "Release for all tabs", fading in with the pull. Also used by the dev fixture. */
export function SessionHeaderPullHint(props: Readonly<{
    progress: SharedValue<number>;
    offset: SharedValue<number>;
    ready: boolean;
    top: number;
}>) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const style = useAnimatedStyle(() => ({
        opacity: props.progress.value,
        transform: [{ translateY: Math.max(4, props.offset.value / 2 - 15) }],
    }), [props.offset, props.progress]);
    return (
        <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.hint, { top: props.top, backgroundColor: materialColor(theme.colors.surface.elevated) }, style]}
            testID="session-header-pull-hint"
        >
            <Icon name="arrow-down" size={14} color={props.ready ? theme.colors.text.primary : theme.colors.text.secondary} />
            <Text style={[styles.hintText, props.ready ? styles.hintTextReady : null]}>
                {props.ready ? t('phoneNav.allTabs.releaseHint') : t('phoneNav.allTabs.pullHint')}
            </Text>
        </Animated.View>
    );
}

/** The whole header band: follows the pull and shows the hint above itself. */
export function SessionHeaderPullHost(props: Readonly<{
    onOpen: () => void;
    /** The header's own top inset; the hint sits in the gap that opens below it. */
    hintTop: number;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    children: React.ReactNode;
}>) {
    const deviceType = useDeviceType();
    const settingEnabled = useSetting('sessionHeaderPullAllTabsEnabled') !== false;
    const reducedMotion = useReducedMotionPreference();
    const available = Platform.OS !== 'web' && deviceType === 'phone' && settingEnabled;

    const offset = useSharedValue(0);
    const progress = useSharedValue(0);
    const readySV = useSharedValue(false);
    const [ready, setReady] = React.useState(false);
    const onOpenRef = React.useRef(props.onOpen);
    onOpenRef.current = props.onOpen;
    const open = React.useCallback(() => {
        void hapticsLight();
        onOpenRef.current();
    }, []);

    useAnimatedReaction(() => readySV.value, (next, previous) => {
        if (next === previous) return;
        scheduleOnRN(setReady, next);
        // One tick as the threshold is crossed outward; none on the way back.
        if (next && previous === false) scheduleOnRN(hapticsSelection);
    }, [readySV]);

    const gesture = React.useMemo(() => {
        if (!available) return null;
        const spring = reanimatedMotionTokens.spring.travel;
        return Gesture.Pan()
            .withTestId('session-header-pull')
            // Downward only, and only once it is clearly vertical: a sideways drag or an upward one is
            // not this gesture, and the transcript below never reaches it.
            .activeOffsetY(SESSION_HEADER_PULL_ARM_PX)
            .failOffsetY(-SESSION_HEADER_PULL_ARM_PX)
            .failOffsetX([-SESSION_HEADER_PULL_ARM_PX, SESSION_HEADER_PULL_ARM_PX])
            .onUpdate((event: { translationY?: number }) => {
                'worklet';
                const frame = resolveSessionHeaderPullFrame({ translationY: event.translationY ?? 0 });
                offset.value = reducedMotion ? 0 : frame.offset;
                progress.value = frame.progress;
                readySV.value = frame.ready;
            })
            .onEnd((event: { translationY?: number }, success?: boolean) => {
                'worklet';
                if (resolveSessionHeaderPullRelease({ translationY: event.translationY ?? 0, cancelled: success === false })) {
                    scheduleOnRN(open);
                }
            })
            .onFinalize(() => {
                'worklet';
                offset.value = reducedMotion ? 0 : withSpring(0, spring);
                progress.value = reducedMotion ? 0 : withSpring(0, spring);
                readySV.value = false;
            });
    }, [available, offset, open, progress, readySV, reducedMotion]);

    const bandStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }), [offset]);
    const context = React.useMemo(() => ({ gesture }), [gesture]);

    return (
        <SessionHeaderPullContext.Provider value={context}>
            <SessionHeaderPullHint progress={progress} offset={offset} ready={ready} top={props.hintTop} />
            <Animated.View style={[props.style, bandStyle]} testID={props.testID}>
                {props.children}
            </Animated.View>
        </SessionHeaderPullContext.Provider>
    );
}

/** The identity and title: the only part of the header a pull can start from. */
export function SessionHeaderPullTarget(props: Readonly<{ style?: StyleProp<ViewStyle>; children: React.ReactNode }>) {
    const { gesture } = React.useContext(SessionHeaderPullContext);
    const content = <View style={props.style}>{props.children}</View>;
    // Gesture identity is stable for the screen's life (it changes only with the setting), so the
    // detector does not come and go during use.
    return gesture ? <GestureDetector gesture={gesture}>{content}</GestureDetector> : content;
}
