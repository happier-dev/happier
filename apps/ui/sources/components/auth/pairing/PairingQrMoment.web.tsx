import * as React from 'react';
import { View } from 'react-native';
import { glyphFrame } from '@happier-dev/brand/glyph-scene';
import { createPairingGlyphSampler, pairingGlyphCell } from '@happier-dev/brand/planet-moments';
import { prepareWebGlyphLayer } from '@/components/atmosphere/glyph/webGlyphLayer';
import { releaseCanvasBackingStore } from '@/components/ui/media/canvasBackingStore';
import {
  loadMomentFonts,
  paintMomentCommands,
  prepareMomentCanvas,
} from '@/components/atmosphere/momentPaint.web';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import {
  selectQrMomentFrame,
  type QrMomentFrameRequest,
  type QrMomentScene,
} from './pairingQrMomentTimeline';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';
import { createPairingQrMomentFrames } from './pairingQrMomentFrame';

export const PAIRING_QR_MOMENT_SUPPORTED = true;

const defaultFrames = createPairingQrMomentFrames();
const defaultGlyphs = createPairingGlyphSampler();

let markImage: HTMLImageElement | null = null;
function happierMark(): HTMLImageElement | null {
  if (markImage || typeof Image === 'undefined') return markImage;
  const source = require('@/assets/images/logo-black.png') as unknown;
  const uri =
    typeof source === 'string'
      ? source
      : ((source as { uri?: string; default?: { uri?: string } | string })
          ?.uri ??
        (
          (source as { default?: { uri?: string } | string })?.default as
            | { uri?: string }
            | undefined
        )?.uri ??
        (typeof (source as { default?: unknown })?.default === 'string'
          ? (source as { default: string }).default
          : ''));
  markImage = new Image();
  markImage.src = uri;
  return markImage;
}

/** Paints one frame request; the component's loop and the drawing harness share it. */
export async function paintPairingQrMomentRequest(
  canvas: HTMLCanvasElement,
  request: QrMomentFrameRequest,
  props: PairingQrMomentCanvasProps,
  dpr: number,
  build = defaultFrames,
) {
  const { size } = props;
  const context = prepareMomentCanvas(canvas, size, size, dpr);
  if (!context) return;
  const env = { w: size, h: size, dpr, mark: happierMark() };
  const view = { w: size, h: size };
  const frame = defaultGlyphs(build(request, props, dpr), view, dpr);
  paintMomentCommands(context, frame.behind, env);
  if (frame.planet) {
    const { warmWebGlyphAtlas, paintWebStill } = await import('@/components/atmosphere/glyph/glyphPainter.web');
    const sampled = glyphFrame({ view, dpr, theme: props.theme, layers: [frame.planet.layer], cell: pairingGlyphCell });
    const atlas = await warmWebGlyphAtlas(sampled.grid, dpr);
    const still = document.createElement('canvas');
    still.width = sampled.width; still.height = sampled.height;
    paintWebStill(still, sampled, atlas);
    context.save();
    context.globalAlpha = frame.planet.opacity;
    context.drawImage(still, 0, 0, size, size);
    context.restore();
    releaseCanvasBackingStore(still);
  }
  paintMomentCommands(context, frame.ahead, env);
}

const sameRequest = (
  a: QrMomentFrameRequest | null,
  b: QrMomentFrameRequest | null,
) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The pairing code block as the brand moment (lab `mo-qr` / `mo-pair`, square card layout): digits
 * assemble into the exact code, an expiring code re-forms, a scan folds it into the planet, and the
 * new machine lights on the horizon when the Home confirms. Frames run only while something moves;
 * a held code costs nothing. Under reduced motion each event lands on its rest frame with a short
 * cross-fade, as the lab specifies.
 */
export const PairingQrMomentCanvas = React.memo(function PairingQrMomentCanvas(
  props: PairingQrMomentCanvasProps & Readonly<{ scene: QrMomentScene }>,
) {
  const build = React.useMemo(createPairingQrMomentFrames, []);
  const split = React.useMemo(createPairingGlyphSampler, []);
  const live = React.useRef<HTMLCanvasElement | null>(null);
  const ahead = React.useRef<HTMLCanvasElement | null>(null);
  const planet = React.useRef<HTMLCanvasElement | null>(null);
  const still = React.useRef<HTMLCanvasElement | null>(null);
  const previous = React.useRef<HTMLCanvasElement | null>(null);
  const [glyphs, setGlyphs] = React.useState<ReturnType<typeof prepareWebGlyphLayer> | null>(null);
  const [contextRevision, redraw] = React.useReducer((revision: number) => revision + 1, 0);
  const latest = React.useRef(props);
  latest.current = props;
  const shown = React.useRef<QrMomentFrameRequest | null>(null);
  const paintedFor = React.useRef('');
  const { scene, size, theme, reducedMotion, pairing } = props;
  const activelyViewed = useHostActivelyViewed();
  const presented = useLayoutPresentationActive();
  const visible = activelyViewed && presented;
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  React.useEffect(() => {
    if (!planet.current || !still.current) return;
    let active = true;
    const vectorLayers = [live.current, ahead.current, previous.current];
    setGlyphs(null);
    const layer = prepareWebGlyphLayer(planet.current, still.current, dpr, pairingGlyphCell, redraw);
    void layer.ready.then(() => { if (active) setGlyphs(layer); }, () => { /* The accessible QR remains available. */ });
    return () => {
      active = false;
      layer.dispose();
      for (const canvas of vectorLayers) releaseCanvasBackingStore(canvas);
    };
  }, [dpr]);

  React.useEffect(() => {
    if (!visible || !glyphs) return;
    const canvas = live.current;
    const foreground = ahead.current;
    if (!canvas || !foreground) return;
    const env = { w: size, h: size, dpr, mark: happierMark() };
    let frame = 0;
    let cancelled = false;
    const paintGlyphs = (requested: QrMomentFrameRequest) => {
      const view = { w: size, h: size };
      const frame = split(build(requested, latest.current, dpr), view, dpr);
      const pixels = glyphs.paint({ view, theme, layers: frame.planet ? [frame.planet.layer] : [] }, 0);
      if (pixels) pixels.style.opacity = String(frame.planet?.opacity ?? 0);
      return { frame, pixels };
    };
    const crossFade = () => {
      const under = previous.current;
      const last = shown.current;
      if (!under || !last) return;
      const context = prepareMomentCanvas(under, size, size, dpr);
      if (!context) return;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(canvas, 0, 0);
      const { pixels, frame } = paintGlyphs(last);
      if (pixels && frame.planet) {
        context.globalAlpha = frame.planet.opacity;
        context.drawImage(pixels, 0, 0);
        context.globalAlpha = 1;
      }
      context.drawImage(foreground, 0, 0);
      under.style.transition = 'none';
      under.style.opacity = '1';
      void under.offsetWidth;
      under.style.transition = `opacity ${motionTokens.atmosphere.reducedCrossFadeMs}ms ease-out`;
      under.style.opacity = '0';
    };
    const step = () => {
      if (cancelled) return;
      const selection = selectQrMomentFrame(scene, performance.now(), {
        reducedMotion: reducedMotion || !glyphs.animated,
        pairing,
      });
      // A theme, size or machine change repaints the frame on screen without a cross-fade.
      const key = `${theme}|${size}|${contextRevision}|${latest.current.machines.join('\u0000')}`;
      const repaint = key !== paintedFor.current;
      if (selection.request && (repaint || !sameRequest(selection.request, shown.current))) {
        if (reducedMotion && shown.current && !repaint) crossFade();
        paintedFor.current = key;
        const { frame } = paintGlyphs(selection.request);
        const backgroundContext = prepareMomentCanvas(canvas, size, size, dpr);
        if (backgroundContext) paintMomentCommands(backgroundContext, frame.behind, env);
        const foregroundContext = prepareMomentCanvas(foreground, size, size, dpr);
        if (foregroundContext) paintMomentCommands(foregroundContext, frame.ahead, env);
        shown.current = selection.request;
      }
      if (selection.animating)
        frame = requestAnimationFrame(step);
    };
    void loadMomentFonts().then(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [scene, size, theme, reducedMotion, pairing, props.machines, visible, dpr, build, split, glyphs, contextRevision]);

  return (
    <View pointerEvents="none" style={{ width: size, height: size }}>
      <canvas
        ref={live}
        aria-hidden
        style={{ position: 'absolute', inset: 0, width: size, height: size }}
      />
      <canvas ref={planet} aria-hidden style={{ position: 'absolute', inset: 0, width: size, height: size, visibility: 'hidden' }} />
      <canvas ref={still} aria-hidden style={{ position: 'absolute', inset: 0, width: size, height: size, visibility: 'hidden' }} />
      <canvas ref={ahead} aria-hidden style={{ position: 'absolute', inset: 0, width: size, height: size }} />
      <canvas
        ref={previous}
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          width: size,
          height: size,
          opacity: 0,
        }}
      />
    </View>
  );
});
