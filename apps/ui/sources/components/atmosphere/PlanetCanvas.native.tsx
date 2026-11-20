import * as React from 'react';
import { PixelRatio } from 'react-native';
import { Canvas, Picture, Skia, createPicture } from '@shopify/react-native-skia';
import { snapCanvasBox } from '@/components/ui/media/canvasBackingStore';
import { createPlanetCanvasDotsCache } from './planetCanvasDots';
import type { PlanetCanvasProps } from './planetCanvas.types';
import { paintNativePlanetDots } from './planetCanvasPaintDots.native';

export const PlanetCanvas = React.memo(function PlanetCanvas(props: PlanetCanvasProps) {
    const dpr = PixelRatio.get();
    const box = snapCanvasBox(props.width, props.height, dpr);
    const resolve = React.useMemo(createPlanetCanvasDotsCache, []);
    const dots = props.mark ? resolve(props.mark) : props.dots;
    const scale = props.mark ? props.width / (props.mark.size ?? 24) : 1;
    const ink = props.mark?.ink ?? props.ink;
    const picture = React.useMemo(() => createPicture(canvas => {
        const paint = Skia.Paint();
        paint.setAntiAlias(true);
        canvas.scale(scale, scale);
        paintNativePlanetDots(canvas, paint, dots, ink);
        paint.dispose();
    }, { width: box.width, height: box.height }), [box.height, box.width, dots, ink, scale]);
    React.useEffect(() => () => { picture.dispose(); }, [picture]);
    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={props.testID} style={[props.style, { width: box.width, height: box.height }]}>
        <Picture picture={picture} />
    </Canvas>;
});
