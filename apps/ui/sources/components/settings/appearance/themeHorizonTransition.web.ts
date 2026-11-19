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
import { prepareWebGlyphLayer } from '@/components/atmosphere/glyph/webGlyphLayer';
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

/**
 * The atmosphere's theme switch (lab TH3): the new theme rises as the limb of a huge planet (night
 * descends from above) with a band of typewriter digits riding the boundary. The boundary, glow and
 * digits are the brand's `themeSwitchFrame`; this file is the web port the lab specifies: a View
 * Transition whose new root is clipped per frame, and one overlay canvas drawn from the same frame.
 */
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
    const w = view.innerWidth,
      h = view.innerHeight,
      dpr = Math.min(2, view.devicePixelRatio || 1);
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${w}px`,
      height: `${h}px`,
      pointerEvents: 'none',
      zIndex: '2147483647',
    });
    overlay.style.setProperty('view-transition-name', THEME_HORIZON_LAYER);
    const canvas = document.createElement('canvas');
    const glyphCanvas = document.createElement('canvas');
    const still = document.createElement('canvas');
    for (const layer of [canvas, glyphCanvas, still]) {
      Object.assign(layer.style, { position: 'absolute', inset: '0', width: `${w}px`, height: `${h}px` });
      overlay.appendChild(layer);
    }
    body.appendChild(overlay);
    const glyphs = prepareWebGlyphLayer(glyphCanvas, still, dpr, themeHorizonGlyphCell);
    const horizon = createThemeHorizonGlyphSampler();
    return (transition) => {
      const duration = FURTHER_PLANET_MOMENT_TIMINGS.TH.DUR;
      let frame = 0;
      let reveal: Animation | null = null;
      let disposed = false;
      // A finished reveal holds its last clip (fill: both); release it so switches never accumulate.
      const remove = () => {
        if (disposed) return;
        disposed = true;
        view.cancelAnimationFrame(frame);
        glyphs.dispose();
        releaseCanvasBackingStore(canvas);
        overlay.remove();
        reveal?.cancel();
      };
      // `finished` settles even when the browser skips the transition, so the overlay never outlives it.
      void transition.finished.then(remove, remove);
      // Font readiness may settle before `ready`, or after the transition has been skipped.
      void glyphs.ready.catch(remove);
      void transition.ready.then(() => {
        if (disposed) return;
        const running = document.documentElement.animate(
          themeHorizonClipKeyframes(w, h, direction),
          {
            duration: duration * 1000,
            easing: 'linear',
            fill: 'both',
            pseudoElement: '::view-transition-new(root)',
          },
        );
        reveal = running;
        // The switch has applied by `ready`: the digits take the incoming theme's ink, so they read on it.
        const ink = themeHorizonInk(readThemeRuntimeInk());
        const paint = () => {
          if (disposed) return;
          // The digits read the reveal's own clock, so the band can never drift from the boundary.
          const t = Number(running.currentTime ?? 0) / 1000;
          const sampled = horizon(t, { w, h, dir: direction, kind: 'horizon' }, ink);
          const context = prepareMomentCanvas(canvas, w, h, dpr);
          if (context) paintMomentCommands(context, sampled.commands, { w, h, dpr });
          if (glyphs.animated) glyphs.paint({ view: { w, h }, theme: direction === 'sunrise' ? 'light' : 'dark', layers: [sampled.glyphs] }, t);
          else glyphs.paint({ view: { w, h }, theme: direction === 'sunrise' ? 'light' : 'dark', layers: [] }, t);
          if (t < duration) frame = view.requestAnimationFrame(paint);
        };
        void glyphs.ready.then(() => {
          if (disposed) return;
          frame = view.requestAnimationFrame(paint);
        }, remove);
      }, remove);
    };
  },
};
