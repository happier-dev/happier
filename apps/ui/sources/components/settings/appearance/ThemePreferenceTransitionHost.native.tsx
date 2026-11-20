import * as React from 'react';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import { PixelRatio, StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Canvas, Image, Picture, createPicture, type SkCanvas, type SkImage } from '@shopify/react-native-skia';
import { captureNativeLayer } from '@/components/ui/motion/stepMotion/freezeLayer.native';
import { createThemeHorizonGlyphSampler, FURTHER_PLANET_MOMENT_TIMINGS, themeHorizonGlyphCell } from '@happier-dev/brand/planet-moments';
import { useAtmosphereMoment } from '@/components/atmosphere/atmosphereMoments';
import { useNativeMomentEnvironment } from '@/components/atmosphere/useNativeMomentEnvironment';
import { GlyphSurface, type GlyphMotion, type GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/GlyphSurface.native';
import { readThemeRuntimeInk } from '@/theme/profiles/themeProfileRuntime';
import { paintNativeThemeHorizon } from './themeHorizonPaint.native';
import { themeHorizonInk } from './themeHorizonInk';
import { createNativeThemePreferenceTransitionController } from './nativeThemePreferenceTransitionController';
import { registerNativeThemePreferenceTransitionController } from './themePreferenceTransition';
import { THEME_TRANSITION_DURATION_MS, THEME_TRANSITION_EASING_BEZIER } from './themePreferenceTransitionMotion';

type Overlay = Readonly<{ image: SkImage; direction: 'sunrise' | 'night'; horizon: boolean; ink: string }>;

/** Reveals the incoming theme with the Horizon or the native wipe. */
export function ThemePreferenceTransitionHost(props: Readonly<{ children: React.ReactNode }>) {
    const surface = React.useRef<View>(null);
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    const [overlay, setOverlay] = React.useState<Overlay | null>(null);
    const [playing, setPlaying] = React.useState(false);
    const moment = useAtmosphereMoment('themeSwitch');
    const signedIn = useOptionalAuth()?.isAuthenticated === true;
    const preference = React.useRef(false); preference.current = moment.on && signedIn;
    const complete = React.useRef<(() => void) | null>(null);
    const disposed = React.useRef(false);
    const reveal = useSharedValue(0);
    const clip = useAnimatedStyle(() => ({ height: size.height * (1 - reveal.value) }));
    const finish = React.useCallback(() => { complete.current?.(); complete.current = null; }, []);
    React.useEffect(() => {
        disposed.current = false;
        let horizon = false;
        const controller = createNativeThemePreferenceTransitionController({
            async captureSurface() {
                const view = surface.current;
                if (!view) return null;
                const image = await captureNativeLayer(view);
                if (disposed.current) {
                    image?.dispose();
                    return null;
                }
                return image;
            },
            showOverlay(image, direction = 'sunrise') {
                horizon = preference.current;
                reveal.value = 0;
                // The switch applied before the overlay shows: its digits take the incoming theme's ink.
                setOverlay({ image, direction, horizon, ink: readThemeRuntimeInk() });
            },
            waitForFrame: () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())),
            animateOverlay: () => disposed.current ? undefined : new Promise<void>(resolve => {
                complete.current = resolve;
                if (horizon) setPlaying(true);
                else reveal.value = withTiming(1, { duration: THEME_TRANSITION_DURATION_MS, easing: Easing.bezier(...THEME_TRANSITION_EASING_BEZIER) }, () => { runOnJS(finish)(); });
            }),
            hideOverlay() {
                setPlaying(false); setOverlay(null);
            },
            releaseSurface: image => image.dispose(),
        });
        const unregister = registerNativeThemePreferenceTransitionController(controller);
        return () => { disposed.current = true; unregister(); cancelAnimation(reveal); finish(); };
    }, [reveal, finish]);
    return <View style={{ flex: 1 }} onLayout={event => setSize(event.nativeEvent.layout)}>
        <View ref={surface} collapsable={false} style={{ flex: 1 }}>{props.children}</View>
        {overlay ? <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
            {overlay.horizon ? <HorizonOverlay overlay={overlay} size={size} playing={playing} onDone={finish} /> : <Animated.View style={[StyleSheet.absoluteFill, { overflow: 'hidden' }, clip]}>
                <CapturedTheme image={overlay.image} size={size} />
            </Animated.View>}
        </View> : null}
    </View>;
}

function HorizonOverlay({ overlay, size, playing, onDone }: Readonly<{
    overlay: Overlay;
    size: { width: number; height: number };
    playing: boolean;
    onDone: () => void;
}>) {
    const [loadError, setLoadError] = React.useState(false);
    const onLoadError = React.useCallback(() => setLoadError(true), []);
    const env = useNativeMomentEnvironment(size.width, size.height, PixelRatio.get(), onLoadError);
    const environment = React.useRef(env);
    environment.current = env;
    const horizon = React.useMemo(createThemeHorizonGlyphSampler, []);
    const ink = React.useMemo(() => themeHorizonInk(overlay.ink), [overlay.ink]);
    const sampled = React.useRef<ReturnType<typeof horizon> | null>(null);
    const [drawn, setDrawn] = React.useState(false);
    const drawnRef = React.useRef(false);
    const ready = env !== null && size.width > 0 && size.height > 0;
    const { direction, image } = overlay;
    const duration = FURTHER_PLANET_MOMENT_TIMINGS.TH.DUR;
    const motion = React.useMemo<GlyphMotion>(() => {
        if (!playing) return null;
        let startedAt: number | undefined;
        return {
            kind: 'sequence',
            readTimeS: now => ready ? (now - (startedAt ??= now)) / 1000 : 0,
            continues: t => {
                if (t >= duration) onDone();
                return ready && t < duration;
            },
            onSuspended: onDone,
        };
    }, [duration, onDone, playing, ready]);
    const scene = React.useCallback((seconds: number, readiness?: GlyphSurfaceReadiness) => {
        if (!playing || !ready || readiness === 'still') {
            sampled.current = null;
            if (playing && readiness === 'still') onDone();
            return [];
        }
        sampled.current = horizon(seconds, { w: size.width, h: size.height, dir: direction, kind: 'horizon' }, ink);
        return [sampled.current.glyphs];
    }, [direction, horizon, ink, onDone, playing, ready, size.height, size.width]);
    const composePicture = React.useCallback((drawGlyphs: (canvas: SkCanvas) => void) => createPicture(canvas => {
        const frame = sampled.current;
        const currentEnv = environment.current;
        if (!frame || !currentEnv) return;
        paintNativeThemeHorizon(canvas, image, frame, currentEnv);
        drawGlyphs(canvas);
    }, size), [image, size]);
    const onPaint = React.useCallback(() => {
        if (!sampled.current || drawnRef.current) return;
        drawnRef.current = true;
        setDrawn(true);
    }, []);
    React.useEffect(() => { if (playing && loadError) onDone(); }, [loadError, onDone, playing]);
    return <>
        {!drawn ? <CapturedTheme image={image} size={size} /> : null}
        <GlyphSurface width={size.width} height={size.height} scene={scene} motion={motion}
            theme={direction === 'sunrise' ? 'light' : 'dark'} cell={themeHorizonGlyphCell}
            style={StyleSheet.absoluteFill} composePicture={composePicture} onPaint={onPaint} />
    </>;
}

function CapturedTheme(props: Readonly<{ image: SkImage; size: { width: number; height: number } }>) {
    return <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Image image={props.image} x={0} y={0} width={props.size.width} height={props.size.height} fit="fill" />
    </Canvas>;
}
