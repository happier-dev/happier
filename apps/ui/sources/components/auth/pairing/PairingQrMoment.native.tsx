import * as React from 'react';
import { Animated, PixelRatio, View } from 'react-native';
import { Canvas, Picture, Skia, createPicture, type SkPicture } from '@shopify/react-native-skia';
import { useSharedValue } from 'react-native-reanimated';
import { createGlyphFrameSampler } from '@happier-dev/brand/glyph-scene';
import { createPairingGlyphSampler, pairingGlyphCell } from '@happier-dev/brand/planet-moments';
import { paintNativeMomentCommands } from '@/components/atmosphere/momentPaint.native';
import { createNativeGlyphPainter } from '@/components/atmosphere/glyph/glyphPainter.native';
import { readGlyphLowPower } from '@/components/atmosphere/glyph/readGlyphLowPower.native';
import { useNativeMomentEnvironment } from '@/components/atmosphere/useNativeMomentEnvironment';
import { useCanvasRenderState } from '@/components/atmosphere/useCanvasRenderState';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { createPairingQrMomentFrames } from './pairingQrMomentFrame';
import { selectQrMomentFrame, type QrMomentScene } from './pairingQrMomentTimeline';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';

export const PAIRING_QR_MOMENT_SUPPORTED = true;

/** Same event timeline and brand command stream as web; the native scene rests without a frame loop. */
export const PairingQrMomentCanvas = React.memo(function PairingQrMomentCanvas(props: PairingQrMomentCanvasProps & Readonly<{ scene: QrMomentScene }>) {
    const { size, scene, theme, reducedMotion, pairing, machines } = props;
    const dpr = PixelRatio.get();
    const env = useNativeMomentEnvironment(size, size, dpr);
    const state = useCanvasRenderState({ size: { width: size, height: size } });
    const build = React.useMemo(createPairingQrMomentFrames, []);
    const split = React.useMemo(createPairingGlyphSampler, []);
    const sample = React.useMemo(createGlyphFrameSampler, []);
    type Painter = Awaited<ReturnType<typeof createNativeGlyphPainter>>;
    const [graphics, setGraphics] = React.useState<{ painter: Painter; lowPower: boolean } | null>(null);
    const current = useSharedValue<SkPicture | null>(null);
    const [previous, setPrevious] = React.useState<SkPicture | null>(null);
    const retired = React.useRef<SkPicture | null>(null);
    const [opacity] = React.useState(() => new Animated.Value(0));
    const shown = React.useRef<SkPicture | null>(null);
    const latest = React.useRef({ props, env }); latest.current = { props, env };
    const envReady = env !== null;
    const mark = env?.mark;
    React.useEffect(() => {
        let active = true;
        let held: Painter | null = null;
        setGraphics(null);
        const cell = [Math.round(pairingGlyphCell[0] * dpr), Math.round(pairingGlyphCell[1] * dpr)] as const;
        void Promise.all([createNativeGlyphPainter({ cell, cols: 0, rows: 0, origin: [0, 0] }, dpr), readGlyphLowPower()]).then(([painter, lowPower]) => {
            if (!active) { painter.dispose(); return; }
            held = painter;
            setGraphics({ painter, lowPower });
        }, () => { /* The accessible QR remains available if the decorative atlas fails. */ });
        return () => { active = false; held?.dispose(); };
    }, [dpr]);
    React.useEffect(() => {
        if (!envReady || !state.visible || !graphics) return;
        const { painter, lowPower } = graphics;
        let cancelled = false, frame = 0;
        let fade: Animated.CompositeAnimation | undefined;
        const step = () => {
            if (cancelled || !latest.current.env) return;
            const selection = selectQrMomentFrame(scene, performance.now(), { reducedMotion: reducedMotion || lowPower, pairing });
            if (selection.request) {
                const env = latest.current.env;
                const view = { w: size, h: size };
                const frame = split(build(selection.request, latest.current.props, dpr), view, dpr);
                const next = createPicture(canvas => {
                    paintNativeMomentCommands(canvas, frame.behind, env);
                    if (frame.planet) {
                        const glyphs = sample({ view, dpr, theme, layers: [frame.planet.layer], cell: pairingGlyphCell });
                        const opacity = Skia.Paint();
                        try {
                            opacity.setAlphaf(frame.planet.opacity);
                            canvas.saveLayer(opacity);
                            painter.draw(canvas, glyphs);
                        } finally {
                            canvas.restore();
                            opacity.dispose();
                        }
                    }
                    paintNativeMomentCommands(canvas, frame.ahead, env);
                }, { width: size, height: size });
                const before = shown.current;
                current.value = next;
                shown.current = next;
                if (before && reducedMotion && !lowPower) {
                    setPrevious(before);
                    opacity.setValue(1);
                    fade = Animated.timing(opacity, { toValue: 0, duration: motionTokens.atmosphere.reducedCrossFadeMs, useNativeDriver: true });
                    fade.start(({ finished }) => { if (finished && !cancelled) setPrevious(null); });
                } else {
                    if (retired.current) setPrevious(null);
                    before?.dispose();
                }
            }
            if (selection.animating) frame = requestAnimationFrame(step);
        };
        step();
        return () => { cancelled = true; cancelAnimationFrame(frame); fade?.stop(); };
    }, [scene, size, theme, reducedMotion, pairing, machines, dpr, envReady, mark, state.visible, sample, split, graphics, build, opacity, current]);
    React.useLayoutEffect(() => {
        retired.current?.dispose();
        retired.current = previous;
    }, [previous]);
    React.useEffect(() => () => {
        current.value = null;
        shown.current?.dispose(); shown.current = null;
        retired.current?.dispose(); retired.current = null;
    }, [current]);
    return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
        <Canvas style={{ width: size, height: size }}>{graphics ? <Picture picture={current as unknown as { value: SkPicture }} /> : null}</Canvas>
        {previous ? <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, opacity }}>
            <Canvas style={{ width: size, height: size }}><Picture picture={previous} /></Canvas>
        </Animated.View> : null}
    </View>;
});
