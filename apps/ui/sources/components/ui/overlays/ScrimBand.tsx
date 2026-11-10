import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useGlassBlurSetting } from '@/components/ui/glass/useGlassBlurSetting';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import {
    createFloatingBackdropPictureWebStyle,
    createScrimBandWebLayers,
    type FloatingBackdropPicture,
    type FloatingBackdropStrength,
    type ScrimBandAxes,
} from './createBackdropLayerStyle';
import { OverlayScrim } from './OverlayScrim';
import { useDerivedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { SCRIM_RAMP_UNDERLAP } from './progressiveScrimFalloff';

const asViewStyle = (style: unknown) => style as ViewStyle;

/**
 * The frost around a surface that leaves the page in use (the Docked composer): `OverlayScrim`'s band on
 * web, at a backdrop strength and carrying the soft picture. Like `OverlayScrim` it positions itself against
 * the surface it seats, so it stays glued at any height, and it reaches the window's edge through `reach`.
 * It only ever fades; it hit-tests to nothing, so the page stays usable beneath it.
 */
export const ScrimBand = React.memo(function ScrimBand(props: Readonly<{
    /** False while the surface is leaving. */
    shown: boolean;
    rampHeight: number;
    /** Where the seated surface starts below the rows standing on the band (`OverlayScrim`'s `seatTop`). */
    seatTop?: number;
    progress: SharedValue<number>;
    axes: ScrimBandAxes;
    strength: FloatingBackdropStrength;
    picture: FloatingBackdropPicture | null;
    /**
     * How far the surface sits from the window's right and bottom edges. A `centre` band reads `left` and
     * `right` as the room beside the surface in its column: it clears sideways within that room, never past it.
     */
    reach: Readonly<{ left?: number; right: number; bottom: number }>;
    testID?: string;
}>): React.ReactElement {
    return Platform.OS === 'web' ? <WebScrimBand {...props} /> : <NativeScrimBand {...props} />;
});

function NativeScrimBand(props: React.ComponentProps<typeof ScrimBand>) {
    const reducedMotion = useReducedMotionPreference();
    const { shown, progress: entranceProgress } = props;
    const progress = useDerivedValue(() => shown ? entranceProgress.value : withTiming(0, {
        duration: reducedMotion ? 0 : motionTokens.overlay.popover.exitMs,
    }));
    return <OverlayScrim progress={progress} rampHeight={props.rampHeight} seatTop={props.seatTop}
        strength={props.strength} picture={props.picture} reach={props.reach} testID={props.testID} />;
}

function WebScrimBand(props: React.ComponentProps<typeof ScrimBand>) {
    const { theme } = useUnistyles();
    const { blurEnabled } = useGlassBlurSetting();
    const reducedMotion = useReducedMotionPreference();
    const [settled, setSettled] = React.useState(false);
    React.useEffect(() => {
        const frame = requestAnimationFrame(() => setSettled(true));
        return () => cancelAnimationFrame(frame);
    }, []);
    const rise = -(props.rampHeight - SCRIM_RAMP_UNDERLAP);
    // A centred band reaches sideways only as far as its column allows, and dissolves across exactly that.
    const sidePx = props.axes === 'centre' ? Math.min(-rise, props.reach.left ?? 0, props.reach.right) : undefined;
    const layers = React.useMemo(() => createScrimBandWebLayers({
        ground: theme.colors.surface.base,
        enableBlur: blurEnabled,
        strength: props.strength,
        rampPx: props.rampHeight,
        axes: props.axes,
        ...(sidePx === undefined ? {} : { sidePx }),
    }), [blurEnabled, props.axes, props.rampHeight, props.strength, sidePx, theme.colors.surface.base]);
    const fade = asViewStyle({
        opacity: reducedMotion ? (props.shown ? 1 : 0) : settled && props.shown ? 1 : 0,
        transitionProperty: 'opacity',
        transitionDuration: `${reducedMotion ? 0 : props.shown ? motionTokens.overlay.popover.enterMs : motionTokens.overlay.popover.exitMs}ms`,
    });
    const picture = props.picture && blurEnabled ? (
        <View style={[asViewStyle(layers.picture), fade]}>
            <View style={asViewStyle(createFloatingBackdropPictureWebStyle(props.picture, props.strength, 'bottom'))} />
        </View>
    ) : null;
    return (
        <View
            testID={props.testID}
            pointerEvents="none"
            style={{
                position: 'absolute',
                top: (props.seatTop ?? 0) + rise,
                left: sidePx === undefined ? -props.reach.right : -sidePx,
                right: sidePx === undefined ? -props.reach.right : -sidePx,
                bottom: -props.reach.bottom,
            }}
        >
            {layers.blur.map((layer, index) => <View key={index} style={[asViewStyle(layer), fade]} />)}
            {/* The band's ground is opaque under the seated rows, so the picture goes beneath it and tints only
                the dissolve, as on native. */}
            {picture}
            <View style={[asViewStyle(layers.veil), fade]} />
        </View>
    );
}
