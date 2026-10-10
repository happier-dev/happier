import * as React from 'react';
import { drawPlanetMarkFrame } from '@happier-dev/brand/planet';
import { Canvas, Picture, Skia, createPicture } from '@shopify/react-native-skia';
import { useDerivedValue } from 'react-native-reanimated';

import type { VoiceMarkCanvasProps } from './voiceMarkCanvasTypes';

/**
 * Native renderer for the Voice mark: one Skia picture of plain circles, recorded on the UI thread
 * from the prebuilt Brand geometry and the energy owner's SharedValues. It re-records only when one
 * of those values changes, so a settled mark — at rest, in silence — schedules nothing.
 */
export const VoiceMarkCanvas = React.memo(function VoiceMarkCanvas(props: VoiceMarkCanvasProps) {
    const { to, from, morph, pose, energy, flow, gather, leave } = props;
    const width = to.maxX - to.minX;
    const height = to.maxY - to.minY;
    const offsetX = to.minX;
    const offsetY = to.minY;
    const picture = useDerivedValue(() => createPicture((canvas) => {
        const paint = Skia.Paint();
        paint.setAntiAlias(true);
        const colour = new Float32Array(4);
        drawPlanetMarkFrame(to, from, morph.value, pose.value, energy.value, flow.value, (x, y, radius, r, g, b, a) => {
            colour[0] = r;
            colour[1] = g;
            colour[2] = b;
            colour[3] = a;
            paint.setColor(colour);
            canvas.drawCircle(x - offsetX, y - offsetY, radius, paint);
        }, gather.value, leave.value);
    }, { width, height }));
    return (
        <Canvas
            pointerEvents="none"
            style={{ position: 'absolute', left: offsetX, top: offsetY, width, height }}
        >
            <Picture picture={picture} />
        </Canvas>
    );
});
