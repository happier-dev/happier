import * as React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
    cancelAnimation,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierDisclosure,
    type HappierDisclosureBodyProps,
    type HappierDisclosureHeaderState,
    type HappierDisclosureMotion,
    type HappierDisclosureMotionDriver,
    type HappierDisclosureProps,
} from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ItemRevealContext } from './ItemRevealContext';

/**
 * Happier core's binding of the disclosure contract (`HappierDisclosure` in `@happier-dev/plugin-ui`):
 * the Reanimated motion driver, the app's reduced-motion preference and the hairline colour. The
 * contract itself — semantics, height and opacity together, the body following its content, a
 * hairline only between items — lives in the shared presentation owner.
 */
export type ExpandableItemHeaderState = HappierDisclosureHeaderState;

type ReanimatedDisclosureMotion = HappierDisclosureMotion & Readonly<{
    height: SharedValue<number>;
    opacity: SharedValue<number>;
}>;

function useReanimatedDisclosureMotion(initiallyExpanded: boolean): ReanimatedDisclosureMotion {
    const height = useSharedValue(0);
    const opacity = useSharedValue(initiallyExpanded ? 1 : 0);
    return React.useMemo(() => ({
        height,
        opacity,
        setHeight: (value) => {
            height.value = value;
        },
        animateHeight: (to, durationMs, onFinished) => {
            height.value = withTiming(to, { duration: durationMs }, (finished) => {
                'worklet';
                if (finished) runOnJS(onFinished)();
            });
        },
        setOpacity: (value) => {
            opacity.value = value;
        },
        animateOpacity: (to, durationMs) => {
            opacity.value = withTiming(to, { duration: durationMs });
        },
        cancel: () => {
            cancelAnimation(height);
            cancelAnimation(opacity);
        },
    }), [height, opacity]);
}

// Once settled the body follows its content. Native clears an animated property returned as
// `undefined`; the web implementation skips `undefined` and would keep the last pixel height, so
// `auto` is the explicit "follow the content" value there.
const SETTLED_HEIGHT = Platform.OS === 'web' ? 'auto' : undefined;

function ReanimatedDisclosureBody(props: HappierDisclosureBodyProps<ReanimatedDisclosureMotion>) {
    const { height, opacity } = props.motion;
    const pinned = props.pinned;
    // Always the same keys: Reanimated's native updater does not reset a property that disappears
    // from the returned object, so `height` is `undefined`/`auto` rather than absent once unpinned.
    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
        height: pinned ? height.value : SETTLED_HEIGHT,
    }), [pinned]);
    return (
        <Animated.View testID={props.testID} style={[props.style as StyleProp<ViewStyle>, animatedStyle]}>
            {props.children}
        </Animated.View>
    );
}

/** Also the disclosure motion the host hands mounted plugin surfaces (`createPluginUiPrivatePresentationHost`). */
export const reanimatedDisclosureMotion: HappierDisclosureMotionDriver<ReanimatedDisclosureMotion> = {
    useMotion: useReanimatedDisclosureMotion,
    Body: ReanimatedDisclosureBody,
};

const styles = StyleSheet.create((theme) => ({
    separator: {
        // The canonical border token, softened by the contract's opacity into a faint line.
        backgroundColor: theme.colors.border.default,
    },
}));

/**
 * The caret an expandable row's header shows at its end: one glyph, one size and the secondary ink
 * for every accordion row, so headers never pick their own. Decorative; the header's pressable owns
 * the expanded state it mirrors (`header={(state) => <Item rightElement={<ExpandableItemCaret expanded={state.expanded} />} />}`).
 */
export function ExpandableItemCaret(props: Readonly<{ expanded: boolean }>) {
    const { theme } = useUnistyles();
    return (
        <Icon
            name={props.expanded ? 'caret-down' : 'caret-right'}
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
        />
    );
}

export type ExpandableItemProps = Omit<HappierDisclosureProps, 'motion' | 'reducedMotion' | 'separatorStyle'> & Readonly<{
    reducedMotion?: boolean;
}>;

/** An accordion row: the `peek` disclosure with Happier core's motion. */
export const ExpandableItem = React.memo(function ExpandableItem(props: ExpandableItemProps) {
    const detectedReducedMotion = useReducedMotionPreference();
    const revealRequest = React.useContext(ItemRevealContext);
    const stateRef = React.useRef(props);
    stateRef.current = props;
    React.useEffect(() => {
        // Reveal is an intent, not a forced state: a controlled parent may refuse, and the person
        // may close it afterwards. Only a new enclosing request asks it to open again.
        if (revealRequest !== null && !stateRef.current.expanded) {
            stateRef.current.onExpandedChange(true);
        }
    }, [revealRequest]);
    return (
        <HappierDisclosure
            {...props}
            reducedMotion={props.reducedMotion ?? detectedReducedMotion}
            motion={reanimatedDisclosureMotion}
            separatorStyle={styles.separator}
        />
    );
});
