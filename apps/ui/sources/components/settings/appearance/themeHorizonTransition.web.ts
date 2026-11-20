import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  createThemeHorizonGlyphSampler,
  FURTHER_PLANET_MOMENT_TIMINGS,
  themeHorizonGlyphCell,
  themeHorizonClip,
} from '@happier-dev/brand/planet-moments';
import {
  paintMomentCommands,
  prepareMomentCanvas,
} from '@/components/atmosphere/momentPaint.web';
import { GlyphSurface, type GlyphMotion, type GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/GlyphSurface.web';
import { releaseCanvasBackingStore } from '@/components/ui/media/canvasBackingStore';
import { readThemeRuntimeInk } from '@/theme/profiles/themeProfileRuntime';
import { themeHorizonInk } from './themeHorizonInk';
import type { WebThemePreferenceChoreography } from './themePreferenceTransition';

/** The overlay's view-transition group: captured in both views (empty in the old), drawn live above the root. */
export const THEME_HORIZON_LAYER = 'happier-theme-horizon';
/** One clip keyframe per display frame at 60 Hz, so the boundary follows the brand curve exactly. */
const KEYFRAMES_PER_SECOND = 60;
const STYLE_ID = 'happier-theme-horizon-style';
// The overlay only paints; the old root stays as captured and the new root is revealed by the clip.
// The pseudo tree never takes input, so the app stays usable while the horizon passes.
const STYLE = `::view-transition { pointer-events: none; }
::view-transition-group(${THEME_HORIZON_LAYER}), ::view-transition-image-pair(${THEME_HORIZON_LAYER}), ::view-transition-new(${THEME_HORIZON_LAYER}) { animation: none; }
::view-transition-old(${THEME_HORIZON_LAYER}) { display: none; }`;

/** The brand clip path of the incoming theme at each display frame (TH3 Horizon). */
export function themeHorizonClipKeyframes(
  w: number,
  h: number,
  dir: 'sunrise' | 'night',
): Keyframe[] {
  const duration = FURTHER_PLANET_MOMENT_TIMINGS.TH.DUR;
  const steps = Math.round(duration * KEYFRAMES_PER_SECOND);
  const frames: Keyframe[] = [];
  // The brand frame at t = 0 hides the layer and at t = DUR is unclipped; neither interpolates with a circle,
  // so the first and last display frames hold the nearest boundary (below the window, and covering it).
  for (let i = 1; i < steps; i++) {
    frames.push({
      offset: i / steps,
      clipPath: themeHorizonClip((i / steps) * duration, { w, h, dir }),
    });
  }
  return [
    { ...frames[0], offset: 0 },
    ...frames,
    { ...frames[frames.length - 1], offset: 1 },
  ];
}

type HorizonViewport = Readonly<{ w: number; h: number; dpr: number; direction: 'sunrise' | 'night' }>;
type HorizonPlayback = Readonly<{ reveal: Animation; ink: ReturnType<typeof themeHorizonInk> }>;

function HorizonSurface({ viewport, playback }: Readonly<{ viewport: HorizonViewport; playback: HorizonPlayback | null }>) {
  const { w, h, dpr, direction } = viewport;
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const horizon = React.useMemo(createThemeHorizonGlyphSampler, []);
  const duration = FURTHER_PLANET_MOMENT_TIMINGS.TH.DUR;
  const motion = React.useMemo<GlyphMotion>(() => playback ? {
    kind: 'sequence',
    readTimeS: () => Number(playback.reveal.currentTime ?? 0) / 1000,
    continues: t => t < duration,
  } : null, [duration, playback]);
  const scene = React.useCallback((seconds: number, readiness?: GlyphSurfaceReadiness) => {
    const layer = canvas.current;
    if (!layer || !playback) return [];
    const context = prepareMomentCanvas(layer, w, h, dpr);
    if (readiness === 'still') return [];
    const sampled = horizon(seconds, { w, h, dir: direction, kind: 'horizon' }, playback.ink);
    if (context) paintMomentCommands(context, sampled.commands, { w, h, dpr });
    return [sampled.glyphs];
  }, [direction, dpr, h, horizon, playback, w]);
  React.useLayoutEffect(() => {
    const backing = canvas.current;
    return () => releaseCanvasBackingStore(backing);
  }, []);
  return React.createElement(React.Fragment, null,
    React.createElement('canvas', { ref: canvas, 'aria-hidden': true,
      style: { position: 'absolute', inset: 0, width: w, height: h } }),
    React.createElement(GlyphSurface, { width: w, height: h, pixelRatio: dpr, scene, motion,
      theme: direction === 'sunrise' ? 'light' : 'dark', cell: themeHorizonGlyphCell }),
  );
}

/** The browser clips the new root. Its reveal time drives the shared glyph and glow frame. */
export const themeHorizonTransition: WebThemePreferenceChoreography = {
  prepare(document, direction) {
    const view = document.defaultView;
    const body = document.body;
    if (!view || !body) return null;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    const viewport = { w: view.innerWidth, h: view.innerHeight, dpr: Math.min(2, view.devicePixelRatio || 1), direction };
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${viewport.w}px`,
      height: `${viewport.h}px`,
      pointerEvents: 'none',
      zIndex: '2147483647',
    });
    overlay.style.setProperty('view-transition-name', THEME_HORIZON_LAYER);
    body.appendChild(overlay);
    const root = createRoot(overlay);
    root.render(React.createElement(HorizonSurface, { viewport, playback: null }));
    return (transition) => {
      let reveal: Animation | null = null;
      let disposed = false;
      const remove = () => {
        if (disposed) return;
        disposed = true;
        root.unmount();
        overlay.remove();
        reveal?.cancel();
      };
      // `finished` settles even when the browser skips the transition.
      void transition.finished.then(remove, remove);
      void transition.ready.then(() => {
        if (disposed) return;
        reveal = document.documentElement.animate(themeHorizonClipKeyframes(viewport.w, viewport.h, direction), {
          duration: FURTHER_PLANET_MOMENT_TIMINGS.TH.DUR * 1000,
          easing: 'linear',
          fill: 'both',
          pseudoElement: '::view-transition-new(root)',
        });
        // The destination theme has applied by `ready`.
        const playback = { reveal, ink: themeHorizonInk(readThemeRuntimeInk()) };
        root.render(React.createElement(HorizonSurface, { viewport, playback }));
      }, remove);
    };
  },
};
