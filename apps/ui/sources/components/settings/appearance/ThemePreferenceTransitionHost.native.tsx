import * as React from 'react';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import { PixelRatio, StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Canvas, Image, Picture, createPicture, type SkImage, type SkPicture } from '@shopify/react-native-skia';
import { captureNativeLayer } from '@/components/ui/motion/stepMotion/freezeLayer.native';
import { createGlyphFrameSampler } from '@happier-dev/brand/glyph-scene';
import { createThemeHorizonGlyphSampler, FURTHER_PLANET_MOMENT_TIMINGS, themeHorizonGlyphCell } from '@happier-dev/brand/planet-moments';
import { useAtmosphereMoment } from '@/components/atmosphere/atmosphereMoments';
import { useCanvasRenderState } from '@/components/atmosphere/useCanvasRenderState';
import { useNativeMomentEnvironment } from '@/components/atmosphere/useNativeMomentEnvironment';
import { createNativeGlyphPainter } from '@/components/atmosphere/glyph/glyphPainter.native';
import { readGlyphLowPower } from '@/components/atmosphere/glyph/readGlyphLowPower.native';
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
            {overlay.horizon ? <HorizonOverlay overlay={overlay} size={size} playing={playing} reducedMotion={moment.reducedMotion} onDone={finish} /> : <Animated.View style={[StyleSheet.absoluteFill, { overflow: 'hidden' }, clip]}>
                <CapturedTheme image={overlay.image} size={size} />
            </Animated.View>}
        </View> : null}
    </View>;
}

function HorizonOverlay(props: Readonly<{ overlay: Overlay; size: { width: number; height: number }; playing: boolean; reducedMotion: boolean; onDone: () => void }>) {
    const [loadError, setLoadError] = React.useState(false);
    const onLoadError = React.useCallback(() => setLoadError(true), []);
    const env = useNativeMomentEnvironment(props.size.width, props.size.height, PixelRatio.get(), onLoadError);
    const image = props.overlay.image;
    const state = useCanvasRenderState({ size: props.size });
    const picture = useSharedValue<SkPicture | null>(null);
    const previous = React.useRef<SkPicture | null>(null);
    const [drawn, setDrawn] = React.useState(false);
    const latest = React.useRef({ env, image }); latest.current = { env, image };
    const ready = env !== null;
    const { playing, reducedMotion, onDone, overlay } = props;
    React.useEffect(() => {
        if (!playing) return;
        if (loadError || !state.visible || reducedMotion) { onDone(); return; }
        if (!ready) return;
        let frame = 0, live = true;
        let painter: Awaited<ReturnType<typeof createNativeGlyphPainter>> | null = null;
        let start: number | null = null;
        const dpr = PixelRatio.get();
        const cell = [Math.round(themeHorizonGlyphCell[0] * dpr), Math.round(themeHorizonGlyphCell[1] * dpr)] as const;
        const sample = createGlyphFrameSampler();
        const horizon = createThemeHorizonGlyphSampler();
        const ink = themeHorizonInk(overlay.ink);
        const step = (time: number) => {
            const { env, image } = latest.current;
            if (!live || !env || !image || !painter) return;
            start ??= time;
            const t = (time - start) / 1000;
            if (t >= FURTHER_PLANET_MOMENT_TIMINGS.TH.DUR) { onDone(); return; }
            const view = { w: env.w, h: env.h };
            const sampleAt = horizon(t, { ...view, dir: overlay.direction, kind: 'horizon' }, ink);
            const next = createPicture(canvas => {
                paintNativeThemeHorizon(canvas, image, sampleAt, env);
                painter?.draw(canvas, sample({ view, theme: overlay.direction === 'sunrise' ? 'light' : 'dark', layers: [sampleAt.glyphs], cell: themeHorizonGlyphCell, dpr }));
            }, props.size);
            picture.value = next;
            if (previous.current) previous.current.dispose();
            else setDrawn(true);
            previous.current = next;
            frame = requestAnimationFrame(step);
        };
        void readGlyphLowPower().then(lowPower => {
            if (!live) return;
            if (lowPower) { onDone(); return; }
            return createNativeGlyphPainter({ cell, origin: [0, 0], rows: 0, cols: 0 }, dpr);
        }).then(value => {
            if (!value) return;
            if (!live) { value.dispose(); return; }
            painter = value;
            frame = requestAnimationFrame(step);
        }, () => { if (live) onDone(); });
        return () => { live = false; cancelAnimationFrame(frame); painter?.dispose(); };
    }, [playing, ready, loadError, state.visible, reducedMotion, onDone, overlay.direction, overlay.ink, props.size, picture]);
    React.useEffect(() => () => {
        picture.value = null;
        previous.current?.dispose();
        previous.current = null;
    }, [picture]);
    return drawn
        ? <Canvas style={StyleSheet.absoluteFill}><Picture picture={picture as unknown as { value: SkPicture }} /></Canvas>
        : <CapturedTheme image={image} size={props.size} />;
}

function CapturedTheme(props: Readonly<{ image: SkImage; size: { width: number; height: number } }>) {
    return <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Image image={props.image} x={0} y={0} width={props.size.width} height={props.size.height} fit="fill" />
    </Canvas>;
}
