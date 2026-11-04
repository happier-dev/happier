import * as React from 'react';
import { Animated, Easing, Platform, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';

import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import { resolveCollectionRowNeedsYouHighlight, type CollectionRowNeedsYouHighlight } from './collectionRowNeedsYouHighlight';

/** Whether a row that needs the person has been opened since, and whether it is on screen. */
export type CollectionRowNeedsYouFacts = Readonly<{ unopened: boolean; visible: boolean }>;

/**
 * The opt-in needs-you highlight for one row (owner ruling 2026-11-01). Mount only on a row that needs the
 * person, outside the Needs you shelf: calm rows never subscribe to the preference. Motion also stops while the
 * window or the pane is hidden.
 */
export function useCollectionRowNeedsYouHighlight(facts: CollectionRowNeedsYouFacts): CollectionRowNeedsYouHighlight {
    const preference = useLocalSetting('sessionListNeedsYouHighlight');
    const reducedMotion = useReducedMotionPreference();
    const hostViewed = useHostActivelyViewed();
    const presented = useLayoutPresentationActive();
    return resolveCollectionRowNeedsYouHighlight({
        preference, reducedMotion, unopened: facts.unopened, visible: facts.visible && hostViewed && presented,
    });
}

const GLINT_MS = 900;
const SHIMMER_MS = 3200;
/** The sweep crosses during the first 60% of a Shimmer cycle and rests for the rest (`happierNeedsYouShimmer`). */
const SHIMMER_TRAVEL_SHARE = 0.6;
const BAND_SHARE = 0.4;
const BAND_OPACITY = 0.2;
const ACCENT_WIDTH = 2;

const styles = StyleSheet.create((theme) => ({
    accent: {
        position: 'absolute',
        left: 1,
        top: '25%',
        bottom: '25%',
        width: ACCENT_WIDTH,
        borderRadius: ACCENT_WIDTH / 2,
        backgroundColor: workStatusGlyphColor(theme.colors, 'attention'),
    },
    clip: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        overflow: 'hidden',
        borderRadius: HAPPIER_COLLECTION_ROW_METRICS.radius,
    },
    band: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        width: `${BAND_SHARE * 100}%`,
        opacity: BAND_OPACITY,
    },
}));

/** `#rrggbb` → the same hue at zero alpha, so the band's edges fade through its own colour, not through black. */
function clearOf(color: string): string {
    return /^#[0-9a-f]{6}$/i.test(color) ? `${color}00` : 'transparent';
}

/**
 * The row's leading highlight layer, drawn in the row's `leading` slot under its content: Accent's 2 px amber bar,
 * or the Glint / Shimmer sweep, a soft amber band crossing the row behind the title. Transform-only motion: a CSS
 * animation on the web, the native driver elsewhere; no React render per frame.
 */
export const CollectionRowNeedsYouLeading = React.memo(function CollectionRowNeedsYouLeading(props: CollectionRowNeedsYouFacts & Readonly<{
    testID?: string;
}>) {
    const highlight = useCollectionRowNeedsYouHighlight(props);
    return <CollectionRowNeedsYouLayer leading={highlight.leading} testID={props.testID} />;
});

/**
 * The drawn layer for a decided highlight. The Appearance tiles render it `still` (the sweep held mid-row), so the
 * choice shows the real treatment without motion running in Settings.
 */
export function CollectionRowNeedsYouLayer(props: Readonly<{ leading: CollectionRowNeedsYouHighlight['leading']; still?: boolean; testID?: string }>) {
    if (props.leading === 'accent') {
        return <View testID={props.testID ? `${props.testID}:accent` : undefined} pointerEvents="none" style={styles.accent} />;
    }
    if (props.leading === 'glint' || props.leading === 'shimmer') {
        return <NeedsYouSweep kind={props.leading} still={props.still === true} testID={props.testID} />;
    }
    return null;
}

/** React Native Web passes these CSS animation properties through to the element. */
type WebSweepStyle = ViewStyle & {
    animationName?: string;
    animationDuration?: string;
    animationTimingFunction?: string;
    animationFillMode?: string;
};

/** A still frame has no motion to carry it, so the tile draws the band a little stronger to tell Glint/Shimmer from Dot. */
const STILL_BAND_OPACITY = 0.4;
/** Where a still sweep rests: across the middle of the title. */
const STILL_OFFSET_SHARE = 0.75;

function NeedsYouSweep(props: Readonly<{ kind: 'glint' | 'shimmer'; still: boolean; testID?: string }>) {
    const { theme } = useUnistyles();
    const color = workStatusGlyphColor(theme.colors, 'attention');
    const colors = React.useMemo(() => [clearOf(color), color, clearOf(color)] as const, [color]);
    const testID = props.testID ? `${props.testID}:${props.kind}` : undefined;
    if (props.still) {
        return (
            <View pointerEvents="none" style={styles.clip}>
                <LinearGradient testID={testID} colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={[styles.band, { left: `${STILL_OFFSET_SHARE * BAND_SHARE * 100}%`, opacity: STILL_BAND_OPACITY }]} />
            </View>
        );
    }
    if (Platform.OS === 'web') {
        const animation: WebSweepStyle = {
            animationName: props.kind === 'glint' ? 'happierNeedsYouGlint' : 'happierNeedsYouShimmer',
            animationDuration: `${props.kind === 'glint' ? GLINT_MS : SHIMMER_MS}ms`,
            animationIterationCount: props.kind === 'glint' ? 1 : 'infinite',
            animationTimingFunction: props.kind === 'glint' ? 'cubic-bezier(0.2, 0, 0, 1)' : 'linear',
            animationFillMode: 'both',
        };
        return (
            <View pointerEvents="none" style={styles.clip}>
                <LinearGradient testID={testID} colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={[styles.band, animation]} />
            </View>
        );
    }
    return <NativeNeedsYouSweep kind={props.kind} colors={colors} testID={testID} />;
}

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

function NativeNeedsYouSweep(props: Readonly<{ kind: 'glint' | 'shimmer'; colors: readonly [string, string, string]; testID?: string }>) {
    const [width, setWidth] = React.useState(0);
    const progress = React.useRef(new Animated.Value(0)).current;
    const onLayout = React.useCallback((event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width), []);
    React.useEffect(() => {
        if (width <= 0) return;
        progress.setValue(0);
        const travel = Animated.timing(progress, {
            toValue: 1,
            duration: props.kind === 'glint' ? GLINT_MS : SHIMMER_MS * SHIMMER_TRAVEL_SHARE,
            easing: props.kind === 'glint' ? Easing.bezier(0.2, 0, 0, 1) : Easing.linear,
            useNativeDriver: true,
        });
        const animation = props.kind === 'glint' ? travel
            : Animated.loop(Animated.sequence([travel, Animated.delay(SHIMMER_MS * (1 - SHIMMER_TRAVEL_SHARE))]));
        animation.start();
        return () => animation.stop();
    }, [progress, props.kind, width]);
    const band = width * BAND_SHARE;
    const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-band, width + band * 1.6] });
    return (
        <View pointerEvents="none" style={styles.clip} onLayout={onLayout}>
            {width > 0 ? (
                <AnimatedLinearGradient testID={props.testID} colors={props.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={[styles.band, { transform: [{ translateX }] }]} />
            ) : null}
        </View>
    );
}
