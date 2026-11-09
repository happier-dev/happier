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
import { StyleSheet } from 'react-native-unistyles';
import {
    HappierDisclosure,
    type HappierDisclosureBodyProps,
    type HappierDisclosureHeaderState,
    type HappierDisclosureMotion,
    type HappierDisclosureMotionDriver,
    type HappierDisclosureProps,
    happierPageRowDividerInset,
    happierPageRowDividerWidth,
    useHappierPageSection,
} from '@happier-dev/plugin-ui/presentation';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ItemRevealContext } from './ItemRevealContext';
import { PAGE_LIST_METRICS } from './pageListMetrics';
import { useSectionLeadingColumn } from './sectionLeadingColumn';

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
    // On a page section's sheet the hairline is the sheet's row seam, exactly as an `Item` row draws it: from the
    // row's text (past the section's leading column) to the sheet's trailing edge, or to the rows' trailing
    // inset on a flat sheet. Elsewhere the disclosure keeps its own faint line.
    const pageSheet = useHappierPageSection();
    const reservesLeadingColumn = useSectionLeadingColumn(false);
    const pageSeparatorStyle = React.useMemo(() => {
        if (!pageSheet) return null;
        const inset = happierPageRowDividerInset({
            rowInsetPx: pageSheet.rowInsetPx,
            leadingPx: reservesLeadingColumn ? PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx : 0,
            framed: pageSheet.framed,
        });
        return {
            height: happierPageRowDividerWidth(),
            opacity: 1,
            backgroundColor: pageSheet.rowDividerColor,
            marginLeft: inset.marginStart,
            marginRight: inset.marginEnd,
        };
    }, [pageSheet, reservesLeadingColumn]);
    return (
        <HappierDisclosure
            {...props}
            reducedMotion={props.reducedMotion ?? detectedReducedMotion}
            motion={reanimatedDisclosureMotion}
            separatorStyle={pageSeparatorStyle ? [styles.separator, pageSeparatorStyle] : styles.separator}
        />
    );
});
