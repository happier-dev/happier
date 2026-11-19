import * as React from 'react';
import { PixelRatio } from 'react-native';
import { Canvas, Picture, createPicture, useTypeface } from '@shopify/react-native-skia';
import { createPlanetCanvasSceneCache, snapCanvasBox } from './planetCanvasScene';
import type { PlanetCanvasProps } from './planetCanvas.types';
import { paintNativePlanetMark } from './planetCanvasPaint.native';

export const PlanetCanvas = React.memo(function PlanetCanvas(props: PlanetCanvasProps) {
    const regular = useTypeface(require('@/assets/fonts/IBMPlexMono-Regular.ttf'));
    const strong = useTypeface(require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'));
    const dpr = props.options?.dpr ?? PixelRatio.get();
    const box = snapCanvasBox(props.width, props.height, dpr);
    const resolveScene = React.useMemo(createPlanetCanvasSceneCache, []);
    const scene = resolveScene(props, dpr);
    const picture = React.useMemo(() => {
        if (scene.cells.length && (!regular || !strong)) return null;
        return createPicture(canvas => {
            const scale = props.mark ? props.width / (props.mark.size ?? 24) : 1;
            canvas.scale(scale, scale);
            paintNativePlanetMark(canvas, scene, regular, strong, props.mark?.ink ?? props.ink);
        }, { width: box.width, height: box.height });
    }, [box.height, box.width, props.mark?.ink, props.ink, props.mark?.size, props.width, regular, scene, strong]);
    React.useEffect(() => { if (picture) props.onReady?.(); }, [picture, props.onReady]);
    React.useEffect(() => () => { picture?.dispose(); }, [picture]);
    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={props.testID} style={[props.style, { width: box.width, height: box.height }]}>
        {picture ? <Picture picture={picture} /> : null}
    </Canvas>;
});
