import * as React from 'react';
import { Platform, StyleSheet as RNStyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import Color from 'color';
import { useUnistyles } from 'react-native-unistyles';

import { getBlurViewComponent } from '@/components/ui/glass/blurMaterial';
import { resolveGlassCapability } from '@/components/ui/glass/resolveGlassCapability';
import { useGlassBlurSetting } from '@/components/ui/glass/useGlassBlurSetting';
import { useLiquidGlassAvailable } from '@/components/ui/glass/liquidGlass';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';

import { scrimMaskBand, scrimRamp } from './progressiveScrimFalloff';

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
 * `expo-blur` resolves its blur root by walking up to the nearest react-native-screens `Screen`,
 * which for a modal is the modal's own transparent screen — it would blur nothing. That root
 * selection is deliberate upstream behaviour, not a bug to patch around.
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
const SOLID_BOTTOM_EXTENSION = 400;

/**
 * How far the ramp reaches BELOW the seated edge, hidden behind the surface itself.
 *
 * Without it the falloff has to start its climb exactly at the surface's edge, so the strongest
 * frost and the sharp content meet on one line. Starting lower means the band is already at full
 * strength by the time it emerges, and the only visible part of the curve is the dissolve.
 */
const RAMP_UNDERLAP = 28;

/**
 * Strongest first: each layer is revealed nearer the seated edge than the last. Expressed as
 * fractions of the user's glass-blur intensity setting so this surface scales with every other
 * glass surface in the app instead of pinning its own absolute radii.
 */
const BLUR_LAYER_INTENSITY_SCALES = [0.85, 0.22, 0.06] as const;

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
    testID?: string;
}>;

/**
 * The ground runs from FULLY OPAQUE at the seated edge to clear at the top of the ramp.
 *
 * Opaque, not a translucent scrim: the strip around and below the composer is part of the modal,
 * and letting the session list show through it made the composer look like it was floating on
 * nothing. The dissolve above is where the list is meant to reappear.
 *
 * `surface.base`, not `background.canvas`: canvas is the colour BETWEEN the list's rows, and the
 * rows themselves sit on `surface.base`. Against a stack of rows a flat canvas strip reads as a
 * darker band rather than as the same ground. `surface.base` is also what the navigator paints
 * for every other screen, so it is the app's ground in the sense that matters here.
 */
function useDimGradientColors(): string[] {
    const { theme } = useUnistyles();
    const ground = theme.colors.surface.base;

    return React.useMemo(() => {
        const ramp = scrimRamp();
        let base: ReturnType<typeof Color>;
        try {
            base = Color(ground);
        } catch {
            return [ground, 'transparent'];
        }
        return ramp.alphas.map((strength) => base.alpha(strength).rgb().string());
    }, [ground]);
}

const ScrimBlurStack = React.memo(function ScrimBlurStack(props: Readonly<{ baseIntensity: number }>) {
    const { theme } = useUnistyles();
    const BlurView = getBlurViewComponent();
    if (!BlurView) return null;

    return (
        <>
            {BLUR_LAYER_INTENSITY_SCALES.map((scale, index) => {
                const band = scrimMaskBand(index, BLUR_LAYER_INTENSITY_SCALES.length);
                const intensity = Math.max(1, Math.min(100, Math.round(props.baseIntensity * scale)));
                return (
                    <MaskedView
                        key={scale}
                        style={RNStyleSheet.absoluteFillObject}
                        maskElement={(
                            <LinearGradient
                                style={RNStyleSheet.absoluteFillObject}
                                start={GRADIENT_START}
                                end={GRADIENT_END}
                                // The mask reads alpha only; black is simply "keep this pixel".
                                colors={toGradientColors(band.alphas.map((alpha) => `rgba(0,0,0,${alpha})`))}
                                locations={[...band.locations]}
                            />
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
    const dimColors = useDimGradientColors();
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
        blurAvailable: Platform.OS === 'ios',
        webBlurAvailable: false,
        reduceTransparency,
    });
    const showsBlur = Platform.OS === 'ios' && glassBlurEnabled && capability !== 'solid';
    const animatedStyle = useAnimatedStyle(() => ({ opacity: props.progress.value }), [props.progress]);

    return (
        // Positions itself against the surface it seats: it fills that surface and reaches exactly
        // `OVERLAY_SCRIM_RAMP_HEIGHT` above it. Doing this here rather than at the call site is what
        // keeps the ramp a fixed height at ANY composer height — laying it out in flow would make
        // the falloff stretch with the card, and sizing it from the outside would need a
        // measurement the caller does not have.
        <Animated.View
            testID={props.testID}
            pointerEvents="none"
            style={[
                {
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: -(OVERLAY_SCRIM_RAMP_HEIGHT - RAMP_UNDERLAP),
                    bottom: -SOLID_BOTTOM_EXTENSION,
                },
                animatedStyle,
            ]}
        >
            {/* Full strength behind the surface itself. Invisible under an opaque card, and what
                seats anything translucent sitting beside it. */}
            <View
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: OVERLAY_SCRIM_RAMP_HEIGHT,
                    bottom: 0,
                    backgroundColor: dimColors[0],
                }}
            />
            <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: OVERLAY_SCRIM_RAMP_HEIGHT }}>
                {showsBlur ? <ScrimBlurStack baseIntensity={blurIntensity} /> : null}
                <LinearGradient
                    style={RNStyleSheet.absoluteFillObject}
                    start={GRADIENT_START}
                    end={GRADIENT_END}
                    colors={toGradientColors(dimColors)}
                    locations={[...ramp.locations]}
                    // Android dithers gradients by default and it is what keeps a soft ramp from
                    // banding there; harmless elsewhere.
                    dither
                />
            </View>
        </Animated.View>
    );
});
