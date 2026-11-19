import { planetGlyphLayer, type PlanetGlyphOptions } from '@happier-dev/brand/glyph-scene';
import { FURTHER_PLANET_MOMENT_TIMINGS, sessionFinishedRippleFrame } from '@happier-dev/brand/planet-moments';
import { motionTokens } from '@/components/ui/motion/motionTokens';

/**
 * The session-finished ripple as Home's planet plays it (plan UD-4): the brand's frame at Home's real
 * geometry, one clock for the planet's gain and the ring. Admission lives in `homeAtmosphereMoments`.
 */
export type SessionRippleFrame = Readonly<{
  /** The planet's brightness: the brand's gain for this instant, 1 at rest. */
  gain: number;
  /** The ring's normalized progress and its origin (the planet's centre, css px), or none. */
  ring: Readonly<{ progress: number; x: number; y: number }> | null;
  done: boolean;
}>;

const { RIP } = FURTHER_PLANET_MOMENT_TIMINGS;
/** The brand curve holds its full +22 % between 8 % and 10 % of the ripple; the reduced path starts there. */
const REDUCED_PEAK_SECONDS = RIP.DUR * 0.1;

export function sessionRippleLayer(
  options: PlanetGlyphOptions,
  elapsedMs: number,
  input: Pick<Parameters<typeof sessionRippleFrame>[1], 'width' | 'theme' | 'reducedMotion'>,
) {
  const { geometry } = options;
  const frame = sessionRippleFrame(elapsedMs, { ...input, ...geometry });
  const ring = frame.ring;
  return planetGlyphLayer({ ...options, gain: frame.gain, ring: ring ? { progress: ring.progress } : undefined });
}

/**
 * One instant of the ripple on Home's real planet. The full moment is the brand frame (its gain and the
 * ring's progress) at Home's geometry; under reduced motion the planet brightens to the brand's peak
 * and settles back in the shared cross-fade time, and no ring travels.
 */
export function sessionRippleFrame(
  elapsedMs: number,
  input: Readonly<{
    width: number;
    theme: 'light' | 'dark';
    cx: number;
    cy: number;
    R: number;
    reducedMotion: boolean;
  }>,
): SessionRippleFrame {
  const options = {
    w: input.width,
    theme: input.theme,
    px: input.width - input.cx,
    py: input.cy,
    R: input.R,
  };
  if (input.reducedMotion) {
    const settle = motionTokens.atmosphere.reducedCrossFadeMs;
    if (elapsedMs >= settle) return { gain: 1, ring: null, done: true };
    const peak = sessionFinishedRippleFrame(REDUCED_PEAK_SECONDS, options)
      .planet.gain;
    return {
      gain: 1 + (peak - 1) * (1 - elapsedMs / settle),
      ring: null,
      done: false,
    };
  }
  const frame = sessionFinishedRippleFrame(elapsedMs / 1000, options);
  const ring =
    frame.ringProgress === null
      ? null
      : {
          progress: frame.ringProgress,
          x: frame.planet.cx,
          y: frame.planet.cy,
        };
  const done = elapsedMs >= RIP.DUR * 1000;
  return { gain: done ? 1 : frame.planet.gain, ring: done ? null : ring, done };
}
