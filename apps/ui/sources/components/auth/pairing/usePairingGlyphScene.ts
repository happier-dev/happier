import * as React from 'react';
import { createPairingGlyphSampler } from '@happier-dev/brand/planet-moments';

import type { GlyphMotion, GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { createPairingQrMomentFrames } from './pairingQrMomentFrame';
import { selectQrMomentFrame, type QrMomentScene } from './pairingQrMomentTimeline';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';

type PairingGlyphFrame = ReturnType<ReturnType<typeof createPairingGlyphSampler>>;
type PlaybackFrame = Readonly<{ frame: PairingGlyphFrame; running: boolean }>;

/** The QR's real event times select one frame for both glyph and vector painting. */
export function usePairingGlyphScene(
    props: PairingQrMomentCanvasProps & Readonly<{ scene: QrMomentScene }>,
    dpr: number,
    enabled: boolean,
) {
    const { size, scene, theme, reducedMotion, pairing, machines } = props;
    const build = React.useMemo(createPairingQrMomentFrames, []);
    const split = React.useMemo(createPairingGlyphSampler, []);
    const sampled = React.useRef<PlaybackFrame | null>(null);
    const stillScene = React.useRef<QrMomentScene | null>(null);
    const motion = React.useMemo<GlyphMotion>(() => ({ kind: 'sequence', continues: () => sampled.current?.running === true }), []);
    const layers = React.useCallback((seconds: number, readiness?: GlyphSurfaceReadiness) => {
        if (!enabled) { sampled.current = null; return []; }
        // Context restoration repaints an event at rest. Only a new event can resume the timeline.
        if (readiness === 'still') stillScene.current = scene;
        const selection = selectQrMomentFrame(scene, seconds * 1000, { reducedMotion: reducedMotion || stillScene.current === scene, pairing });
        const frame = selection.request
            ? split(build(selection.request, { size, theme, reducedMotion, pairing, machines }, dpr), { w: size, h: size }, dpr)
            : null;
        sampled.current = frame ? { frame, running: selection.animating } : null;
        return frame?.planet ? [frame.planet.layer] : [];
    }, [build, dpr, enabled, machines, pairing, reducedMotion, scene, size, split, theme]);
    return { layers, motion, sampled };
}
