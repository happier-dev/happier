import * as React from 'react';
import { Image, Platform, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Circle, Defs, RadialGradient, Stop, Svg } from 'react-native-svg';
import Animated, { Easing, useAnimatedStyle, useDerivedValue, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';

import { HISTORY_SLOTS, useVoiceEnergy } from './useVoiceEnergy';
import {
    PLANET_DARK,
    PLANET_LIGHT,
    VOICE_BREATH,
    VOICE_GRAIN,
    VOICE_LIGHT,
    light,
    useVoiceLightTokens,
    type VoiceLightStop,
} from './voiceLightTokens';

/**
 * The shared *material* every concept is made of.
 *
 * The concepts differ in spatial structure — a band, a sphere, a composer, a
 * column of type. They deliberately share the light itself, because that is what
 * makes them all read as Happier rather than nine unrelated widgets.
 *
 * A bloom is a real radial falloff, drawn as an SVG gradient.
 *
 * It used to be a hard-edged circle put through `filter: blur()`, which looked
 * right on web and was silently flat on iOS: React Native routes `filter` through
 * a SwiftUI wrapper that only exists when `enableSwiftUIBasedFilters()` is on,
 * and it defaults to `false`
 * (`ReactNativeFeatureFlagsDefaults.h:194-196`; `RCTViewComponentView.mm:815-817`
 * early-returns before the wrapper is ever created, and the blur at `:1077` is
 * applied only when that wrapper is non-null). Every bloom would have rendered as
 * a solid disc on iPhone.
 *
 * `expo-blur` is not the fix here. `BlurView` blurs what is *behind* it and tints
 * the result — a frosted backdrop. A bloom is *emissive*: coloured light added on
 * top. The gradient is not a workaround for the missing filter, it is the more
 * correct primitive, and it is what `PlanetOrb` already uses on both platforms.
 */

export type BloomProps = Readonly<{
    /** Diameter before scale, in points. */
    size: number;
    /** Blur radius. Roughly half the size reads as a soft body of light. */
    blur: number;
    stop: VoiceLightStop;
    /** Base alpha before the state's luminosity and the theme's glow gain. */
    alpha: number;
    /** Extra scale applied on top of the animated response. */
    scale?: number;
    /** How strongly amplitude modulates this layer. 0 = ignores the voice. */
    reactivity?: number;
    /**
     * Which way this layer travels with the energy flow.
     *  `+1` grows when Happier speaks, `-1` grows when the user is heard.
     *  `0` ignores direction and only breathes.
     */
    polarity?: number;
    /** Idle breath amplitude multiplier. */
    breath?: number;
    /** Phase offset in radians so stacked layers never move in lockstep. */
    phase?: number;
    style?: ViewStyle;
}>;

/**
 * Blur cost is area × radius, and on any machine without GPU rasterisation (a
 * headless CI browser, a low-end Android, a Tauri window on integrated
 * graphics) a 560px circle with a 90px blur is rasterised on the CPU every
 * frame. So blooms are drawn once at a small intrinsic raster and scaled up by
 * a transform, which scales the blurred bitmap on the compositor instead of
 * re-blurring at full size. Visually identical, ~12× cheaper at the sizes here.
 */
/**
 * The bloom falloff, measured rather than modelled.
 *
 * These stops are fitted to the *actual* radial alpha profile of the blurred
 * disc this replaces: the old formulation was drawn into a canvas and its alpha
 * sampled at 64 angles per radius. Guessing the shape produced a visibly wrong
 * bloom — the intuition "a blurred disc is a plateau plus a shoulder" only holds
 * when the blur is small relative to the radius, and here it is not
 * (`blur / radius ≈ 0.43`), so the profile is essentially Gaussian with **no
 * plateau at all**. The measured peak is 0.96, not 1.0: blurring spreads the
 * light, so the centre never reaches the source alpha.
 *
 * Measured, normalised — offset : multiplier
 *   0.00 : 0.96   0.10 : 0.94   0.20 : 0.89   0.35 : 0.73
 *   0.50 : 0.49   0.65 : 0.26   0.80 : 0.10   0.90 : 0.04   1.00 : 0
 *
 * Worst-case error against the measured profile is 0.012 normalised — about
 * 0.005 absolute alpha at the Horizon bloom, roughly one 8-bit step. The outer
 * radius lands within 0.4% of the blurred original.
 */

/**
 * How far the light reaches past the disc.
 *
 * A Gaussian's visible extent is ~2σ, so the glow's outer radius is the disc
 * radius plus roughly twice the blur — a box of `size + 3.9 × blur`. Measured
 * outer radius 348px against 353px predicted, i.e. within 2%.
 */
const BLOOM_REACH = 3.9;

/**
 * How far the arrival gesture moves the body, and the atmosphere behind it.
 *
 * Deliberately shallower than a full inhale (`0.085 + live * 0.035`): arriving
 * and listening must not look like the same event at different volumes. The
 * gesture is a single lift that reads as "starting"; respiration is the thing
 * that says "the microphone is open", and only the microphone earns it.
 */
const ARRIVAL_BODY_DEPTH = 0.07;
const ARRIVAL_BLOOM_DEPTH = 0.05;

/**
 * One respiration for the whole presence.
 *
 * Body, atmosphere and rings all read this, so the planet inhales as a single
 * organism instead of three layers on three unrelated clocks. `lag` lets the
 * outer layers trail the body slightly — the atmosphere is pushed by the body,
 * not simultaneous with it.
 *
 * Asymmetric on purpose: quicker inhale, brief hold, longer exhale, short rest.
 * A sine wave here reads as a pulse, which is the thing this replaces.
 */
export function breathe(t: number, live: number, lag: number): number {
    'worklet';
    // Rest 4.6s (~13 breaths/min, a calm adult) → attentive 2.9s.
    const period = 4.6 - live * 1.7;
    const phase = ((t - lag) % period + period) % period / period;
    if (phase < 0.34) {
        const u = phase / 0.34;
        return 1 - (1 - u) * (1 - u);
    }
    if (phase < 0.42) return 1;
    if (phase < 0.9) {
        const u = (phase - 0.42) / 0.48;
        return 1 - (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
    }
    return 0;
}

export const Bloom = React.memo(function Bloom(props: BloomProps) {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    const decorativePointerEvents = resolveOverlayPointerEvents('none');
    const {
        alpha, blur, phase = 0, polarity = 0, reactivity = 1, scale = 1, size, stop,
    } = props;
    const breath = props.breath ?? 1;
    // SVG gradient ids are document-global; two blooms on one page must not share.
    const gid = React.useId().replace(/:/g, '');

    /*
     * `blur` stays the caller's tuning knob — it now describes how far the light
     * reaches past the disc rather than a filter radius, which is the same thing
     * it always meant visually.
     *
     * The glow extends beyond `size` exactly as the blurred version did, so the
     * drawing box grows while the *layout* box stays `size` and every caller's
     * positioning math is untouched.
     */
    const box = size + BLOOM_REACH * blur;
    const inset = (box - size) / 2;
    const hex = VOICE_LIGHT[stop];
    const peak = Math.max(0, Math.min(1, alpha * tokens.glowGain));

    const animated = useAnimatedStyle(() => {
        'worklet';
        const lum = energy.luminosity.get();
        const amp = energy.level.get();
        const flow = energy.flow.get();

        // The atmosphere breathes with the body, trailing it by ~0.18s so it
        // reads as light being pushed outward rather than a second animation.
        const t = energy.clock.get();
        const lung = breathe(t, Math.min(1, lum * 1.6), 0.18 + phase * 0.04);
        // §2.4a — the atmosphere respires only when the body does, and takes the
        // same arrival gesture, so the presence stays one organism.
        const respiration = energy.respiration.get();
        const arrival = energy.arrival.get();
        // A coprime sub-pixel drift so active light never perceptibly loops over
        // an hour. It is still when the bounded arrival has settled and there is
        // no breathing or audio energy; connection alone is not visible motion.
        const activeMotion = Math.max(respiration, arrival, Math.min(1, amp));
        const drift = (
            Math.sin(t * 0.43 + phase) * 0.0028
            + Math.sin(t * 0.36 + phase * 1.7) * 0.0035
        ) * activeMotion;
        const breathScale = 1
            + lung * 0.07 * breath * respiration
            + arrival * ARRIVAL_BLOOM_DEPTH * breath
            + drift;

        // Direction is legible without colour: layers with a matching polarity
        // grow, layers with an opposing polarity contract.
        const directional = polarity === 0 ? 0 : flow * polarity;
        const response = amp * reactivity * (0.18 + 0.34 * Math.max(0, directional) + 0.1);
        const contraction = polarity === 0 ? 0 : Math.max(0, -directional) * amp * reactivity * 0.16;

        return {
            opacity: Math.min(1, alpha * (0.28 + lum * 0.95) + amp * reactivity * 0.14),
            transform: [{ scale: scale * breathScale * (1 + response - contraction) }],
        };
    });

    return (
        <Animated.View
            pointerEvents={decorativePointerEvents.nativePointerEvents}
            style={[
                {
                    // The outer box keeps the caller's real geometry, so all
                    // positioning math stays in final-size points.
                    position: 'absolute',
                    width: size,
                    height: size,
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                props.style,
                animated,
                decorativePointerEvents.webStyle,
            ]}
        >
            <Svg
                width={box}
                height={box}
                viewBox="0 0 100 100"
                style={{ position: 'absolute', left: -inset, top: -inset }}
                pointerEvents="none"
            >
                <Defs>
                    <RadialGradient id={`${gid}-bloom`} cx="50%" cy="50%" r="50%">
                        <Stop offset="0%" stopColor={hex} stopOpacity={peak * 0.96} />
                        <Stop offset="10%" stopColor={hex} stopOpacity={peak * 0.94} />
                        <Stop offset="20%" stopColor={hex} stopOpacity={peak * 0.89} />
                        <Stop offset="35%" stopColor={hex} stopOpacity={peak * 0.73} />
                        <Stop offset="50%" stopColor={hex} stopOpacity={peak * 0.49} />
                        <Stop offset="65%" stopColor={hex} stopOpacity={peak * 0.26} />
                        <Stop offset="80%" stopColor={hex} stopOpacity={peak * 0.10} />
                        <Stop offset="90%" stopColor={hex} stopOpacity={peak * 0.04} />
                        <Stop offset="100%" stopColor={hex} stopOpacity={0} />
                    </RadialGradient>
                </Defs>
                <Circle cx="50" cy="50" r="50" fill={`url(#${gid}-bloom)`} />
            </Svg>
        </Animated.View>
    );
});

/**
 * Film grain. 2% at a 16px tile, the same recipe as the onboarding horizon.
 *
 * Without it, soft light on a flat canvas reads as a cheap CSS blur. With it,
 * the light has a material and survives being looked at for eight hours.
 */
export const Grain = React.memo(function Grain(props: Readonly<{ radius?: number; opacity?: number }>) {
    const decorativePointerEvents = resolveOverlayPointerEvents('none');
    const fill: ViewStyle = {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius: props.radius ?? 0,
        opacity: props.opacity ?? VOICE_GRAIN.opacity,
        overflow: 'hidden',
    };

    /*
     * `backgroundImage` / `backgroundRepeat` are web-only styles, so this used to
     * early-return `null` off web — and the native planet quietly lost its
     * material. That is a platform fidelity divergence, which this design treats
     * as a defect rather than something to document.
     *
     * Native tiles the *same* 16×16 texture through `Image` with
     * `resizeMode="repeat"`. It is deliberately static: no animation, no
     * per-frame texture work. One upload, then the platform repeats it for free
     * on a surface that stays on screen for hours.
     */
    if (Platform.OS !== 'web') {
        return (
            <View
                pointerEvents={decorativePointerEvents.nativePointerEvents}
                style={[fill, decorativePointerEvents.webStyle]}
            >
                <Image
                    source={{ uri: GRAIN_TILE }}
                    resizeMode="repeat"
                    style={{ width: '100%', height: '100%' }}
                    // Decorative texture: never announced, never focusable.
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                />
            </View>
        );
    }

    return (
        <View
            pointerEvents={decorativePointerEvents.nativePointerEvents}
            style={[
                {
                    ...fill,
                    backgroundImage: `url(${GRAIN_TILE})`,
                    backgroundSize: `${VOICE_GRAIN.tileSize}px ${VOICE_GRAIN.tileSize}px`,
                    backgroundRepeat: 'repeat',
                } as ViewStyle,
                decorativePointerEvents.webStyle,
            ]}
        />
    );
});

const GRAIN_TILE =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACbklEQVR4nDWT127rMBBE9alxYsex4yJ2UmIxVRgVSvzliwF8HwQQ4pbZs8NKCHETQtyVUsFa+8EY05RS1ratyTl/1HV9eL1eR0opjTE+932XwzCcc85nSimpcEDgMAwH772ilNb4SikNpZTHGB/TNB201l/jOF4ppUpKydGw7/u2Ukp5HIZh+Cil2Gmavkspbl3XJqVE0KDrOmGM+d33XXRdRxC/rqvd951XCF6WRfR975um4UKIJ+QTQh7rujohxKVtWwQj0ez7zjAWIeQGNdU0TSfvPcfs4zjet227LcvCUkp027arEOIB6UqpNsZ4zzkf6ro+/Y8Bg493B4aulFIJeVrrk7X2bK39XJZFggMK5Zy/jDFPFFRKmYoQci+l+HmeH9baE2ThYtu2p5SSgHzXdYDq//7+Gikl5Zx/ghmaVph727bfpmko4DjnHkhY11WHEALGcs7dcfd6vU4YA2MSQn7QvFqWhVtrDyEEbMPFGC+lFOO9Z6CcUhIhBANWOedjXddfyHHOXYdhOFVd1zHMXEoJgInu2P0bEnHOPZEcQtD4N8/z1RhzB0gArYwxoHxBQNM0tVJKY17sHAC11gcoQtcQQlPX9RmmG8fxhv8ocEWXtxc0oAEkpVSgICRDunPuB26EjTEmYpBbgSjcByO9twEjtTij8DzPgPULgPAF5/yUUmJSSig8VqA7TdNRa/0ZY/zBwwJpbMd7T1NK8L6KMd5wjyT4BiMzxlyFFSEBVMECZoHUtyP5siwUCv4/Jjw4rFgI8dP3fagYY23OGbDOxpgLzt57iRn3fa/neUaDG7rhjaAA5/w7pQSF6h8uPvCkmGdInQAAAABJRU5ErkJggg==';

/**
 * The planet limb.
 *
 * A heavily blurred circle has no edge, so it reads as a flat tinted rectangle —
 * which is exactly what a "glow" looks like when it is done lazily. What makes
 * the onboarding hero read as a *body* is the visible curved terminator where
 * the lit disc meets the sky.
 *
 * So this is a genuine disc, very wide relative to its exposed crown (a shallow
 * horizon arc), filled with a gradient that falls off downward, and given only a
 * small blur so the arc survives. The atmosphere above it is a separate soft
 * bloom — light thrown by the body, not the body itself.
 */
export const PlanetLimb = React.memo(function PlanetLimb(props: Readonly<{
    /** Width of the band the limb rises into. */
    width: number;
    /** Height of the band. */
    height: number;
    stop: VoiceLightStop;
    stopSecondary: VoiceLightStop;
    /** Fraction of the band height the crown reaches. */
    crownRatio?: number;
}>) {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    const decorativePointerEvents = resolveOverlayPointerEvents('none');
    // Diameter is the whole game. Too wide (2.4×) and the arc flattens into a
    // straight line — the light reads as a tinted rectangle, which is exactly
    // the failure mode this component exists to avoid. At ~1.45× the sidebar
    // width the crown curves visibly across the middle and drops below the
    // band's floor at the edges, which is what makes the eye read "body", not
    // "gradient".
    const diameter = props.width * 1.45;
    const crown = props.height * (props.crownRatio ?? 0.35);

    const animated = useAnimatedStyle(() => {
        'worklet';
        const lum = energy.luminosity.get();
        const amp = energy.level.get();
        const flow = energy.flow.get();
        // The limb rises when Happier speaks and settles when it listens — the
        // same "sunrise held" gesture in both directions, so state is readable
        // with colour removed.
        const rise = flow * amp * 10 + amp * 4;
        return {
            opacity: 0.2 + lum * 0.8,
            transform: [{ translateY: -rise }, { scale: 1 + amp * 0.012 }],
        };
    });

    return (
        <Animated.View
            pointerEvents={decorativePointerEvents.nativePointerEvents}
            style={[
                {
                    position: 'absolute',
                    width: diameter,
                    height: diameter,
                    borderRadius: diameter,
                    left: (props.width - diameter) / 2,
                    // The disc's top edge lands `crown` above the band's floor.
                    top: props.height - crown,
                    overflow: 'hidden',
                    /*
                     * The rim is a real ring on the disc, so it follows the curve
                     * instead of sitting as a straight bar across the bounding box.
                     *
                     * AMENDED: this used a 2px blur to soften the 1.5pt edge, which
                     * is a no-op on iOS (module header) — the ring would have been
                     * crisp there and soft on web. Rather than ship a platform
                     * split, the ring is now crisp everywhere at a lower alpha,
                     * which reads as soft without a filter. Only ~7% of this disc
                     * is ever on screen (the crown), so the edge is a hairline of
                     * light rather than a drawn outline either way.
                     */
                    borderWidth: 1.5,
                    borderColor: light(props.stop, 0.55, tokens),
                },
                animated,
                decorativePointerEvents.webStyle,
            ]}
        >
            {/*
              * The gradient must resolve inside the *visible crown*, not inside
              * the disc. Only `crown / diameter` of this box is ever on screen —
              * roughly 7% — so stops spread over the top third of the disc would
              * render as one flat colour. These are placed against the exposed
              * fraction so the crown reads bright, the body falls to the
              * secondary stop, and the limb darkens out before the band's floor.
              */}
            <LinearGradient
                colors={[
                    light(props.stop, 1, tokens),
                    light(props.stop, 0.86, tokens),
                    light(props.stopSecondary, 0.52, tokens),
                    light(props.stopSecondary, 0.1, tokens),
                ]}
                locations={[0, 0.018, 0.045, 0.09]}
                style={{ flex: 1 }}
            />
            {/*
              * Digits live INSIDE the body, not across the whole surface.
              * On the artwork they are only legible where the light falls; a
              * field spread over the empty sky reads as noise on a panel rather
              * than texture on a planet. Clipping them to the disc gets the
              * effect for free — the disc is already a rounded overflow clip.
              */}
            <DigitField
                size={9}
                opacity={tokens.dark ? 0.2 : 0.16}
                color={tokens.dark ? '#FFFFFF' : '#2E2140'}
            />
        </Animated.View>
    );
});

/**
 * The digit field.
 *
 * The planet artwork carries a faint field of monospace digits — the thing that
 * makes it read as *Happier's* cosmos rather than a stock gradient. Rendering it
 * as a grid of nodes would cost hundreds of views per orb; instead this is a
 * **single `Text`** of pre-generated digits with monospace metrics and letter
 * spacing, which the layout engine wraps into a grid for free. One node, no
 * per-frame cost, clipped by whatever contains it.
 */
const DIGITS = (() => {
    // Deterministic, so a frozen frame is byte-identical between runs.
    let seed = 20260728;
    const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
    let out = '';
    for (let i = 0; i < 1400; i += 1) {
        // Weighted toward 1/2/3 like the artwork, with occasional 0/8/9.
        const r = next();
        out += r < 0.62 ? String(1 + Math.floor(next() * 3)) : String(Math.floor(next() * 10));
    }
    return out;
})();

export const DigitField = React.memo(function DigitField(props: Readonly<{
    /** Cell size. 9–11 reads as the artwork at orb scale. */
    size?: number;
    opacity?: number;
    color: string;
}>) {
    const size = props.size ?? 9;
    const decorativePointerEvents = resolveOverlayPointerEvents('none');
    return (
        <View
            pointerEvents={decorativePointerEvents.nativePointerEvents}
            aria-hidden={true}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
                { position: 'absolute', inset: 0, overflow: 'hidden', opacity: props.opacity ?? 0.5 },
                decorativePointerEvents.webStyle,
            ]}
        >
            <Text
                selectable={false}
                disableUiFontScaling
                useDefaultTypography={false}
                style={{
                    ...Typography.mono(),
                    fontSize: size,
                    lineHeight: size * 1.45,
                    letterSpacing: size * 0.42,
                    color: props.color,
                }}
            >
                {DIGITS}
            </Text>
        </View>
    );
});

/**
 * Rings that answer the voice.
 *
 * Grok's persona has a single glow behind it, but it pulses on a 1600ms timer
 * and ignores the audio entirely — it says "something is happening", not "this
 * is what I am hearing". These are three concentric rings driven by the real
 * amplitude, released outward on a stagger, so the orb visibly *breathes with
 * the speech* rather than beside it.
 */
const OrbRings = React.memo(function OrbRings(props: Readonly<{
    size: number;
    stop: VoiceLightStop;
}>) {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    return (
        <>
            {[0, 1, 2].map((i) => (
                <OrbRing key={i} index={i} size={props.size} stop={props.stop} tokens={tokens} energy={energy} />
            ))}
        </>
    );
});

const OrbRing = React.memo(function OrbRing(props: Readonly<{
    index: number;
    size: number;
    stop: VoiceLightStop;
    tokens: ReturnType<typeof useVoiceLightTokens>;
    energy: ReturnType<typeof useVoiceEnergy>;
}>) {
    const { energy, index, size, tokens } = props;
    const decorativePointerEvents = resolveOverlayPointerEvents('none');
    // Each ring sits a little further out and lags the one inside it, so a
    // single syllable reads as one wave travelling outward, not three flashes.
    const base = 1 + index * 0.26;
    const lag = index * 0.22;

    const animated = useAnimatedStyle(() => {
        'worklet';
        const amp = energy.level.get();
        const lum = energy.luminosity.get();
        const t = energy.clock.get();
        // The lag is a phase offset on a slow carrier, not a delayed copy of the
        // signal — cheaper than a history read and reads the same at this scale.
        const wave = Math.max(0, Math.sin(t * 2.4 - lag * Math.PI));
        const push = amp * (0.16 + wave * 0.2);
        return {
            opacity: (0.05 + amp * 0.3 * (1 - index * 0.22)) * (0.3 + lum * 0.7),
            transform: [{ scale: base + push }],
        };
    });

    return (
        <Animated.View
            pointerEvents={decorativePointerEvents.nativePointerEvents}
            style={[
                {
                    position: 'absolute',
                    width: size,
                    height: size,
                    borderRadius: size,
                    borderWidth: Math.max(1, size * 0.014),
                    borderColor: light(props.stop, 1, tokens),
                },
                animated,
                decorativePointerEvents.webStyle,
            ]}
        />
    );
});

/**
 * The Happier planet as a live object.
 *
 * Rendered as a real lit sphere with SVG radial gradients rather than stacked
 * blurred rectangles. The whole illusion rests on the gradient's **focal point**
 * (`fx`/`fy`) sitting up and to the right of the circle's centre — that is what
 * a sphere lit from the upper right actually does, and it is why this reads as
 * a body while a centred gradient reads as a disc.
 *
 * SVG rather than Skia deliberately: every Skia consumer in this repo ships a
 * separate `.web` twin because Skia is native-only in practice here, and a
 * concept that looks different on the platform we review it on is not a
 * concept. `react-native-svg` renders identically on web and native.
 */
export const PlanetOrb = React.memo(function PlanetOrb(props: Readonly<{
    size: number;
    /** Tints the whole body toward the current state's light. 0 = pure planet. */
    tint?: VoiceLightStop | null;
    tintAmount?: number;
    /** Show the atmosphere the body throws onto its surroundings. */
    atmosphere?: boolean;
}>) {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    const d = props.size;
    // SVG gradient ids are document-global; two orbs on one page must not share.
    const gid = React.useId().replace(/:/g, '');
    const shade = tokens.dark ? '#03030A' : '#FBFAF9';

    /*
     * The body is alive, and "alive" is specifically *not* a uniform pulse.
     *
     * A circle scaled up and down on the amplitude reads as a mechanical
     * throb — a VU meter wearing a sphere. What reads as breathing is
     * **anisotropic** deformation: the body squashes and stretches on two axes
     * that are slightly out of phase, so its silhouette is never quite the same
     * shape twice, and it never returns through the state it came from.
     *
     *   · a slow organic wobble on two coprime periods (5.9s / 7.3s), always on
     *   · amplitude on top of it, weighted by direction — outward inflates,
     *     inward draws in
     *   · a shear that leans the body toward the light as it swells
     *
     * Every term is a transform, so this stays on the compositor at any size,
     * and it applies wherever the planet appears — orb, sheet, composer chip.
     */
    /*
     * The planet breathes.
     *
     * A sine wave is not breathing — it is a pulse, symmetric and machine-like,
     * and that is what the previous wobble read as. Real respiration is
     * **asymmetric**: a quicker inhale, a brief hold at the top of the breath, a
     * longer exhale, then a short rest before the next one. That asymmetry is
     * the entire difference between "alive" and "animating".
     *
     * At rest the cycle is 4.6s — roughly 13 breaths a minute, a calm adult at
     * rest. While Voice is live it quickens toward 2.9s and deepens slightly,
     * the way breathing does when you are attending to someone. Speech amplitude
     * rides *on top* of the breath rather than replacing it, so the body is
     * always breathing and the voice just moves it further.
     *
     * **And it only breathes when that is true.** §2.4a: respiration means "the
     * microphone is open and I am listening", so the amplitude of the whole
     * respiration term is `energy.respiration` — the capture fact, eased. Idle
     * is still; `connecting` / `acquiring_mic` get the bounded arrival gesture
     * instead; playback with the microphone closed keeps only the amplitude
     * response below, which is a different behaviour and not a quiet breath.
     */
    const body = useAnimatedStyle(() => {
        'worklet';
        const lum = energy.luminosity.get();
        const amp = energy.level.get();
        const flow = energy.flow.get();
        const t = energy.clock.get();
        const respiration = energy.respiration.get();
        const arrival = energy.arrival.get();
        // 1 while the presence is live (the breath quickens), 0 at rest.
        const live = Math.min(1, lum * 1.6);
        const lung = breathe(t, live, 0);

        // Depth. 3.5% was arithmetically a breath and perceptually nothing —
        // on a 32pt planet it moves ~1px. A body you are meant to read as alive
        // needs to actually change size.
        const depth = (0.085 + live * 0.035) * respiration;
        // Speech rides on top of the breath, never instead of it. Outward speech
        // pushes the body out; being heard draws it in.
        const speech = amp * (0.055 + Math.max(0, flow) * 0.07) - Math.max(0, -flow) * amp * 0.035;
        const scale = 1 + lung * depth + arrival * ARRIVAL_BODY_DEPTH + speech;

        return {
            opacity: 0.42 + lum * 0.58,
            transform: [{ scale }],
        };
    });

    const P = tokens.dark ? PLANET_DARK : PLANET_LIGHT;
    const rimColor = tokens.dark ? PLANET_DARK.abyss : PLANET_LIGHT.veil;

    return (
        <View style={{ width: d, height: d, alignItems: 'center', justifyContent: 'center' }}>
            {props.atmosphere !== false ? (
                <>
                    <Bloom size={d * 2.3} blur={d * 0.4} stop="warm" alpha={0.26} polarity={1} reactivity={1.1} />
                    <Bloom size={d * 1.7} blur={d * 0.26} stop="cool" alpha={0.3} polarity={-1} reactivity={0.85} phase={2.1} />
                    <OrbRings size={d} stop={props.tint ?? 'cool'} />
                </>
            ) : null}

            <Animated.View
                style={[
                    { width: d, height: d, borderRadius: d, overflow: 'hidden' },
                    body,
                ]}
            >
                <Svg width={d} height={d} viewBox="0 0 100 100">
                    <Defs>
                        {/* Cool core, filling the disc. */}
                        <RadialGradient id={`${gid}-core`} cx="50%" cy="58%" r="72%">
                            <Stop offset="0%" stopColor={P.core} />
                            <Stop offset="100%" stopColor={P.core} />
                        </RadialGradient>
                        {/*
                          * The crescent. Anchored ABOVE the disc so its falloff
                          * lands on the top rim rather than inside the body —
                          * this is the single most important measurement, and
                          * putting the warm point inside is what made the
                          * previous orb read as a lit ball instead of a planet.
                          */}
                        <RadialGradient id={`${gid}-gold`} cx="52%" cy="-4%" r="62%">
                            <Stop offset="0%" stopColor={P.amber} stopOpacity="1" />
                            <Stop offset="42%" stopColor={P.gold} stopOpacity="0.95" />
                            <Stop offset="78%" stopColor={P.gold} stopOpacity="0.28" />
                            <Stop offset="100%" stopColor={P.gold} stopOpacity="0" />
                        </RadialGradient>
                        {/* Upper-left: the crescent turning red / salmon. */}
                        <RadialGradient id={`${gid}-ember`} cx="16%" cy="18%" r="56%">
                            <Stop offset="0%" stopColor={P.ember} stopOpacity="0.92" />
                            <Stop offset="60%" stopColor={P.ember} stopOpacity="0.34" />
                            <Stop offset="100%" stopColor={P.ember} stopOpacity="0" />
                        </RadialGradient>
                        {/* Left flank: plum on dark, pink on light. */}
                        <RadialGradient id={`${gid}-plum`} cx="-2%" cy="56%" r="52%">
                            <Stop offset="0%" stopColor={P.plum} stopOpacity="0.9" />
                            <Stop offset="66%" stopColor={P.plum} stopOpacity="0.3" />
                            <Stop offset="100%" stopColor={P.plum} stopOpacity="0" />
                        </RadialGradient>
                        {/* Right flank, still catching light. */}
                        <RadialGradient id={`${gid}-azure`} cx="88%" cy="62%" r="58%">
                            <Stop offset="0%" stopColor={P.azure} stopOpacity="0.75" />
                            <Stop offset="70%" stopColor={P.azure} stopOpacity="0.22" />
                            <Stop offset="100%" stopColor={P.azure} stopOpacity="0" />
                        </RadialGradient>
                        {/*
                          * The rim. On dark it is a terminator: transparent at
                          * the top, black at the bottom, anchored above the disc
                          * so the falloff follows the light. On light the planet
                          * dissolves into paper on every edge instead.
                          */}
                        <RadialGradient
                            id={`${gid}-rim`}
                            cx="50%"
                            cy={tokens.dark ? '-6%' : '50%'}
                            r={tokens.dark ? '112%' : '52%'}
                        >
                            <Stop offset={tokens.dark ? '46%' : '58%'} stopColor={rimColor} stopOpacity="0" />
                            <Stop offset={tokens.dark ? '76%' : '86%'} stopColor={rimColor} stopOpacity={tokens.dark ? '0.62' : '0.34'} />
                            <Stop offset="100%" stopColor={rimColor} stopOpacity={tokens.dark ? '0.97' : '0.82'} />
                        </RadialGradient>
                    </Defs>
                    <Circle cx="50" cy="50" r="50" fill={`url(#${gid}-core)`} />
                    <Circle cx="50" cy="50" r="50" fill={`url(#${gid}-azure)`} />
                    <Circle cx="50" cy="50" r="50" fill={`url(#${gid}-plum)`} />
                    <Circle cx="50" cy="50" r="50" fill={`url(#${gid}-ember)`} />
                    <Circle cx="50" cy="50" r="50" fill={`url(#${gid}-gold)`} />
                    <Circle cx="50" cy="50" r="50" fill={`url(#${gid}-rim)`} />
                </Svg>
                {/* Digits stop being texture and start being noise below ~70pt. */}
                {d >= 70 ? (
                    <DigitField
                        size={Math.max(7, d * 0.1)}
                        opacity={tokens.dark ? 0.16 : 0.12}
                        color={tokens.dark ? '#FFFFFF' : '#2E2140'}
                    />
                ) : null}
                {props.tint ? (
                    <View
                        style={{
                            position: 'absolute',
                            inset: 0,
                            backgroundColor: light(props.tint, props.tintAmount ?? 0.07, tokens),
                        }}
                    />
                ) : null}
            </Animated.View>
        </View>
    );
});

/**
 * The scrolling voice meter.
 *
 * Grok's composer puts an animated waveform where a text field used to be, and
 * that is the right instinct: while a conversation is live, the thing worth the
 * horizontal space is *the voice*, not a label.
 *
 * Three decisions that matter:
 *
 *  - **It scrolls, showing the recent past.** A symmetric equaliser never looks
 *    like speech because speech is not symmetric — it is a history of syllables.
 *    Newest sample enters at the right and travels left.
 *  - **Direction encodes who has the floor.** Bars are tinted toward the state's
 *    light, and the meter's brightness gradient runs toward the newest sample
 *    when Happier speaks and away from it when the user is heard.
 *  - **Zero React work.** Every bar reads one slot of the history shared value
 *    inside a worklet. The whole meter costs no re-renders at any amplitude.
 */
/**
 * Measured from the Grok demo's `waveform.tsx`: 28 bars, 3pt wide, 4pt gap,
 * 22pt tall, `MIN_SCALE 0.1`, `withTiming(90)`. Those proportions are the
 * difference between a meter and a decoration, so they are reused verbatim.
 *
 * One deliberate departure: Grok shifts its history on **every audio sample**,
 * which on web is a 128-frame quantum (~187 Hz) and on native a 960-frame
 * buffer (~25 Hz) — so the same component shows a 150ms window on one platform
 * and 1.1s on the other. Happier shifts on a fixed 30 Hz wall clock instead, so
 * the window is always ~1.1s regardless of platform or display refresh rate.
 */
const WAVE_MIN_SCALE = 0.1;
const WAVE_SETTLE_MS = 90;
const WAVE_EASING = Easing.inOut(Easing.quad);

export const VoiceWaveform = React.memo(function VoiceWaveform(props: Readonly<{
    stop: VoiceLightStop;
    /** Full height of the tallest bar. */
    height?: number;
    /** Bar corner treatment. Fully round reads softer at small heights. */
    barWidth?: number;
    /**
     * Render only the newest N samples. Used inside the collapsed orb, where
     * 28 bars would be sub-pixel — a meter you cannot read is decoration.
     */
    slots?: number;
    /** Override the bar colour (the orb's interior needs ink, not light). */
    color?: string;
}>) {
    const tokens = useVoiceLightTokens();
    const height = props.height ?? 22;
    const barWidth = props.barWidth ?? 3;
    const slots = Math.min(HISTORY_SLOTS, props.slots ?? HISTORY_SLOTS);

    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                height,
                flex: 1,
            }}
        >
            {Array.from({ length: slots }, (_, i) => (
                <WaveformBar
                    key={i}
                    index={HISTORY_SLOTS - slots + i}
                    height={height}
                    width={barWidth}
                    color={props.color ?? light(props.stop, 1, tokens)}
                />
            ))}
        </View>
    );
});

const WaveformBar = React.memo(function WaveformBar(props: Readonly<{
    index: number;
    height: number;
    width: number;
    color: string;
}>) {
    const energy = useVoiceEnergy();
    const { height, index, width } = props;
    // Newest slot is last. Age 0 = newest.
    const age = HISTORY_SLOTS - 1 - index;

    /*
     * The 90ms retarget lives in a derived value, not inline in the style.
     *
     * `withTiming` inside `useAnimatedStyle` has no defined starting value for a
     * transform component, and Reanimated resolves that as an uninitialised
     * float — the bars render at `scaleY: 3.4e38` and fill the whole surface.
     * A derived value is initialised properly and produces the identical
     * retargeting behaviour.
     */
    const scale = useDerivedValue(() => {
        'worklet';
        const slot = energy.history.get()[index] ?? 0;
        // MIN_SCALE floor so the meter reads as an instrument at rest rather
        // than vanishing between words — the same 0.1 the Grok demo uses.
        const target = WAVE_MIN_SCALE + (1 - WAVE_MIN_SCALE) * Math.min(1, slot);
        return withTiming(target, { duration: WAVE_SETTLE_MS, easing: WAVE_EASING });
    });

    const animated = useAnimatedStyle(() => {
        'worklet';
        const flow = energy.flow.get();
        // Older samples fade. When Happier speaks the freshest edge is
        // brightest; when the user is heard the trail is, so the meter reads
        // as travelling inward.
        const recency = 1 - age / HISTORY_SLOTS;
        const bias = flow >= 0 ? recency : 0.35 + (1 - recency) * 0.65;
        return {
            opacity: 0.22 + bias * 0.78,
            transform: [{ scaleY: scale.get() }],
        };
    });

    return (
        <Animated.View
            style={[
                {
                    width,
                    height,
                    borderRadius: width,
                    backgroundColor: props.color,
                },
                animated,
            ]}
        />
    );
});

/**
 * A hairline that carries state.
 *
 * The current surface separates sections with a plain divider; here the rule
 * itself is the quietest possible status display, so a resting sidebar shows
 * Voice as one lit line rather than a card.
 */
export const LightRule = React.memo(function LightRule(props: Readonly<{
    stop: VoiceLightStop;
    height?: number;
    /** Travelling highlight, used only while connecting/reconnecting. */
    travel?: boolean;
}>) {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    const height = props.height ?? 1;

    const animated = useAnimatedStyle(() => {
        'worklet';
        const lum = energy.luminosity.get();
        return { opacity: 0.25 + lum * 0.75 };
    });

    const traveller = useAnimatedStyle(() => {
        'worklet';
        if (!props.travel) return { opacity: 0, transform: [{ translateX: 0 }] };
        const t = (energy.clock.get() % 2.4) / 2.4;
        // Ease-in-out so the highlight decelerates at each end instead of
        // snapping — a linear sweep reads as a progress bar, not as breathing.
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        return {
            opacity: Math.sin(t * Math.PI) * 0.9,
            transform: [{ translateX: `${eased * 100}%` }],
        };
    });

    return (
        <View style={{ height, overflow: 'hidden' }}>
            <Animated.View
                style={[
                    { position: 'absolute', inset: 0, backgroundColor: light(props.stop, 0.5, tokens) },
                    animated,
                ]}
            />
            {/*
              * The travelling highlight is a gradient, not a blurred bar.
              * `filter: blur` is a silent no-op on iOS (see the module header),
              * which would have turned this soft sweep into a hard-edged block
              * on iPhone. A transparent→colour→transparent ramp is soft by
              * construction and identical on every platform.
              */}
            <Animated.View
                style={[
                    { position: 'absolute', top: 0, bottom: 0, left: '-30%', width: '30%' },
                    traveller,
                ]}
            >
                <LinearGradient
                    colors={[
                        light(props.stop, 0, tokens),
                        light(props.stop, 1, tokens),
                        light(props.stop, 0, tokens),
                    ]}
                    locations={[0, 0.5, 1]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={{ flex: 1 }}
                />
            </Animated.View>
        </View>
    );
});
