import * as React from 'react';
import { StyleSheet as RNStyleSheet, View, Image } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { useUnistyles } from 'react-native-unistyles';

import { getBlurViewComponent, isNativeBlurAvailable } from '@/components/ui/glass/blurMaterial';
import { resolveGlassCapability } from '@/components/ui/glass/resolveGlassCapability';
import { useGlassBlurSetting } from '@/components/ui/glass/useGlassBlurSetting';
import { useLiquidGlassAvailable } from '@/components/ui/glass/liquidGlass';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';

import { FLOATING_BACKDROP_STRENGTHS, type FloatingBackdropStrength, type FloatingBackdropPicture } from './createBackdropLayerStyle';

import { SCRIM_RAMP_UNDERLAP, scrimBandRamp, scrimBlurLayers, scrimRamp, type ScrimRamp } from './progressiveScrimFalloff';

/**
 * A short band of frost that sits directly on top of a bottom-anchored surface and clears within a
 * few dozen points.
 *
 * It is deliberately NOT a full-screen scrim. Veiling the whole app behind a composer is a sheet
 * with extra steps; this product's reason for a transparent presentation is that the session list
 * stays readable and monitorable WHILE you type. So the scrim's whole job is to seat the composer
 * against the content underneath it — to stop text colliding with text at the card's edge — and
 * then get out of the way.
 *
 * It is rendered in the composer's own slot, immediately above the card, rather than as a
 * full-bleed backdrop. That is what keeps it glued to the card at any composer height: the card
 * grows with chips, attachments and wrapped lines, and a bottom-anchored band of fixed height
 * would either be swallowed by a tall composer or float away from a short one.
 *
 * WHY THE BLUR IS THREE LAYERS AND NOT ONE
 *
 * Neither `expo-blur` nor `expo-glass-effect` has any gradient or variable-radius capability — the
 * iOS view is a plain `UIVisualEffectView`. A single masked blur is the tempting shortcut and the
 * documented failure: it "blooms", with a blurred-to-sharp transition that is nearly invisible.
 * Stacked constant-radius layers, each masked to its own band, are how a falloff is actually built.
 *
 * NOTHING HERE MAY ANIMATE EXCEPT THE WRAPPER'S OPACITY
 *
 * `expo-blur` allocates a fresh `UIViewPropertyAnimator` on every `intensity` write, `MaskedView`
 * on Android re-rasterises a full-size bitmap on every mask invalidation, and
 * `expo-linear-gradient` re-rasterises on every bounds change. Intensities, masks and bounds are
 * therefore all constant, and the single animated node is the opacity of the outer wrapper.
 *
 * ANDROID GETS THE DIM, NOT THE BLUR
 *
 * SDK 55 Android requires an explicit content target. This scrim lives inside its modal,
 * without a target for the content behind that modal, so it uses the shared dim fallback.
 */

/**
 * How far the band reaches above the surface it seats.
 *
 * Short on purpose. Long enough to separate the card from whatever is behind it, short enough that
 * the list above stays legible — which is the entire point of not using a sheet.
 */
export const OVERLAY_SCRIM_RAMP_HEIGHT = 88;

/**
 * How far the solid tier reaches BELOW the surface it seats.
 *
 * The composer is lifted off the bottom of the window by the keyboard seat (the safe-area inset
 * when the keyboard is down), and the strip that opens up underneath it is still part of the
 * modal. Without this the session list showed through a band at the very bottom of the screen.
 * Generous rather than exact: it is behind everything and hit-tests to nothing.
 */
export const OVERLAY_SCRIM_BOTTOM_EXTENSION = 400;

const GRADIENT_START = { x: 0.5, y: 1 } as const;
const GRADIENT_END = { x: 0.5, y: 0 } as const;

type GradientColors = React.ComponentProps<typeof LinearGradient>['colors'];

/**
 * `expo-linear-gradient` types `colors` as a two-or-more tuple, and `Array.prototype.map` erases
 * tuple-ness. Every caller here maps a `ScrimRamp`, whose own type already guarantees two entries,
 * so the shape is sound and this is the one place that says so.
 */
function toGradientColors(colors: readonly string[]): GradientColors {
    return colors as unknown as GradientColors;
}

export type OverlayScrimProps = Readonly<{
    /** 0 = clear, 1 = settled. Read on the UI thread so the band cannot drift from the surface. */
    progress: SharedValue<number>;
    /**
     * How far the band reaches above the seated surface. Defaults to
     * {@link OVERLAY_SCRIM_RAMP_HEIGHT}.
     *
     * A surface may want a taller separation than the shared default without changing it for every
     * other one — the falloff is expressed in fractions of the band, so the whole ramp scales with
     * this and no other value moves.
     */
    rampHeight?: number;
    testID?: string;
    strength?: FloatingBackdropStrength;
    picture?: FloatingBackdropPicture | null;
    reach?: Readonly<{ right: number; bottom: number }>;
}>;

/**
 * The ground under the band, one recipe in every tier: the page colour, opaque under the card and the
 * rows seated on the band (blur alone leaves dense list text readable behind a status line), then
 * dissolving with the shared falloff. Where the device frosts, the frost shows through that dissolve.
 *
 * `surface.base`, not `background.canvas`: canvas is the colour BETWEEN the list's rows, and the
 * rows themselves sit on `surface.base`. Against a stack of rows a flat canvas strip reads as a
 * darker band rather than as the same ground. `surface.base` is also what the navigator paints
 * for every other screen, so it is the app's ground in the sense that matters here.
 */
function useBandGround(): Readonly<{ colors: string[]; ramp: ScrimRamp }> {
    const { theme } = useUnistyles();
    const ground = theme.colors.surface.base;
    return React.useMemo(() => {
        const ramp = scrimBandRamp();
        const base = parseThemeColor(ground);
        if (base === null) return { colors: [ground, 'transparent'], ramp: scrimRamp(2) };
        return { colors: ramp.alphas.map((alpha) => base.alpha(base.alpha() * alpha).rgb().string()), ramp };
    }, [ground]);
}

/**
 * Fills the whole band. Each layer's falloff covers the ramp and then holds to the band's foot, as the web
 * band's mask does: whatever is seated on the band's solid tier (the Docked composer's status row, Search's
 * capsules) stands on frost, never on the sharp page behind a bare dim.
 */
const ScrimBlurStack = React.memo(function ScrimBlurStack(props: Readonly<{ baseIntensity: number; rampHeight: number }>) {
    const { theme } = useUnistyles();
    const BlurView = getBlurViewComponent();
    if (!BlurView) return null;

    return (
        <>
            {scrimBlurLayers().map(({ scale, band }) => {
                const intensity = Math.max(1, Math.min(100, Math.round(props.baseIntensity * scale)));
                return (
                    <MaskedView
                        key={scale}
                        style={RNStyleSheet.absoluteFillObject}
                        maskElement={(
                            <View style={RNStyleSheet.absoluteFillObject}>
                                <LinearGradient
                                    style={{ height: props.rampHeight }}
                                    start={GRADIENT_START}
                                    end={GRADIENT_END}
                                    // The mask reads alpha only; black is simply "keep this pixel".
                                    colors={toGradientColors(band.alphas.map((alpha) => `rgba(0,0,0,${alpha})`))}
                                    locations={[...band.locations]}
                                />
                                <View style={{ flex: 1, backgroundColor: 'black' }} />
                            </View>
                        )}
                    >
                        <BlurView
                            tint={theme.dark ? 'dark' : 'light'}
                            intensity={intensity}
                            style={RNStyleSheet.absoluteFillObject}
                        />
                    </MaskedView>
                );
            })}
        </>
    );
});

export const OverlayScrim = React.memo(function OverlayScrim(props: OverlayScrimProps) {
    const rampHeight = props.rampHeight ?? OVERLAY_SCRIM_RAMP_HEIGHT;
    const ramp = React.useMemo(() => scrimRamp(), []);
    const liquidGlassAvailable = useLiquidGlassAvailable();
    const reduceTransparency = useReduceTransparency();
    const { blurEnabled: glassBlurEnabled, blurIntensity } = useGlassBlurSetting();

    // One decision for the material, shared with every other glass surface in the app rather than
    // re-derived here. Blur is iOS-only for this surface (see the Android note above); Reduce
    // Transparency and the user's blur setting both fall the whole thing back to the dim alone,
    // which is the honest degradation — the dim still seats the card, it just stops being frost.
    const capability = resolveGlassCapability({
        liquidGlassAvailable,
        blurAvailable: isNativeBlurAvailable(),
        webBlurAvailable: false,
        reduceTransparency,
    });
    const showsBlur = isNativeBlurAvailable() && glassBlurEnabled && capability !== 'solid';
    const dim = useBandGround();
    const preset = props.strength ? FLOATING_BACKDROP_STRENGTHS[props.strength] : null;
    const bandBlurIntensity = blurIntensity * (preset ? preset.blurPx / FLOATING_BACKDROP_STRENGTHS.soft.blurPx : 1);
    const picture = glassBlurEnabled && !reduceTransparency && props.picture?.kind === 'picture' ? props.picture : null;
    const animatedStyle = useAnimatedStyle(() => ({ opacity: props.progress.value }), [props.progress]);

    return (
        // Positions itself against the surface it seats: it fills that surface and reaches exactly
        // `rampHeight` above it. Doing this here rather than at the call site is what
        // keeps the ramp a fixed height at ANY composer height — laying it out in flow would make
        // the falloff stretch with the card, and sizing it from the outside would need a
        // measurement the caller does not have.
        <Animated.View
            testID={props.testID}
            pointerEvents="none"
            style={[
                {
                    position: 'absolute',
                    left: -(props.reach?.right ?? 0),
                    right: -(props.reach?.right ?? 0),
                    top: -(rampHeight - SCRIM_RAMP_UNDERLAP),
                    bottom: -(props.reach?.bottom ?? OVERLAY_SCRIM_BOTTOM_EXTENSION),
                },
                animatedStyle,
            ]}
        >
            {showsBlur ? <ScrimBlurStack baseIntensity={bandBlurIntensity} rampHeight={rampHeight} /> : null}
            {/* The picture sits with the frost, under the ground: like the frost it tints only the dissolve,
                never the held page colour under the seated rows. */}
            {picture && preset ? (
                <MaskedView style={RNStyleSheet.absoluteFillObject} maskElement={
                    <View style={{ flex: 1 }}>
                        <LinearGradient style={{ height: rampHeight }} start={GRADIENT_START} end={GRADIENT_END}
                            colors={toGradientColors(ramp.alphas.map(alpha => `rgba(0,0,0,${alpha})`))}
                            locations={[...ramp.locations]} />
                        <View style={{ flex: 1, backgroundColor: 'black' }} />
                    </View>
                }>
                    <Image source={{ uri: picture.uri }} resizeMode="cover" blurRadius={preset.picture.blurPx}
                        style={[RNStyleSheet.absoluteFillObject, { opacity: preset.picture.opacity, transform: [{ scale: preset.picture.scale }] }]} />
                </MaskedView>
            ) : null}
            {/* Full strength behind the surface itself. Invisible under an opaque card, and what
                seats anything translucent sitting beside it. */}
            <View
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: rampHeight,
                    bottom: 0,
                    backgroundColor: dim.colors[0],
                }}
            />
            <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: rampHeight }}>
                <LinearGradient
                    style={RNStyleSheet.absoluteFillObject}
                    start={GRADIENT_START}
                    end={GRADIENT_END}
                    colors={toGradientColors(dim.colors)}
                    locations={[...dim.ramp.locations]}
                    // Android dithers gradients by default and it is what keeps a soft ramp from
                    // banding there; harmless elsewhere.
                    dither
                />
            </View>
        </Animated.View>
    );
});
