import * as React from 'react';
import { Animated, PixelRatio, StyleSheet, View } from 'react-native';
import { Canvas, Picture, Skia, createPicture, type SkCanvas, type SkPicture } from '@shopify/react-native-skia';
import { pairingGlyphCell } from '@happier-dev/brand/planet-moments';

import { GlyphSurface } from '@/components/atmosphere/glyph/GlyphSurface.native';
import { paintNativeMomentCommands } from '@/components/atmosphere/momentPaint.native';
import { useNativeMomentEnvironment } from '@/components/atmosphere/useNativeMomentEnvironment';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import type { QrMomentScene } from './pairingQrMomentTimeline';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';
import { usePairingGlyphScene } from './usePairingGlyphScene';

export const PAIRING_QR_MOMENT_SUPPORTED = true;

export const PairingQrMomentCanvas = React.memo(function PairingQrMomentCanvas(props: PairingQrMomentCanvasProps & Readonly<{ scene: QrMomentScene }>) {
    const { size, scene, theme, reducedMotion } = props;
    const dpr = PixelRatio.get();
    const env = useNativeMomentEnvironment(size, size, dpr);
    const mark = env?.mark;
    const latestEnv = React.useRef(env);
    latestEnv.current = env;
    const { layers, motion, sampled } = usePairingGlyphScene(props, dpr, env !== null);
    const [previous, setPrevious] = React.useState<SkPicture | null>(null);
    const retired = React.useRef<SkPicture | null>(null);
    const drawnScene = React.useRef<QrMomentScene | null>(null);
    const [opacity] = React.useState(() => new Animated.Value(0));
    const composePicture = React.useCallback((drawGlyphs: (canvas: SkCanvas) => void, last: SkPicture | null) => {
        const frame = sampled.current?.frame;
        const environment = latestEnv.current;
        const bounds = { width: size, height: size };
        if (reducedMotion && last && frame && drawnScene.current !== scene) {
            setPrevious(createPicture(canvas => canvas.drawPicture(last), bounds));
        }
        drawnScene.current = scene;
        return createPicture(canvas => {
            if (!frame || !environment) return;
            const vectorEnv = { ...environment, mark };
            paintNativeMomentCommands(canvas, frame.behind, vectorEnv);
            if (frame.planet) {
                const alpha = Skia.Paint();
                try {
                    alpha.setAlphaf(frame.planet.opacity);
                    canvas.saveLayer(alpha);
                    drawGlyphs(canvas);
                } finally {
                    canvas.restore();
                    alpha.dispose();
                }
            }
            paintNativeMomentCommands(canvas, frame.ahead, vectorEnv);
        }, bounds);
    }, [mark, reducedMotion, sampled, scene, size]);
    React.useLayoutEffect(() => {
        retired.current?.dispose();
        retired.current = previous;
        if (!previous) return;
        opacity.setValue(1);
        const fade = Animated.timing(opacity, { toValue: 0, duration: motionTokens.atmosphere.reducedCrossFadeMs, useNativeDriver: true });
        fade.start(({ finished }) => { if (finished) setPrevious(null); });
        return () => fade.stop();
    }, [opacity, previous]);
    React.useEffect(() => () => { retired.current?.dispose(); retired.current = null; }, []);
    return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
        <GlyphSurface width={size} height={size} scene={layers} motion={motion} theme={theme} cell={pairingGlyphCell} composePicture={composePicture} />
        {previous ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
            <Canvas style={{ width: size, height: size }}><Picture picture={previous} /></Canvas>
        </Animated.View> : null}
    </View>;
});
