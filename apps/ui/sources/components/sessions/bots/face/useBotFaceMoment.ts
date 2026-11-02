import * as React from 'react';
import type { BotFaceMood } from './botFaceGeometry';
import { botFaceMomentMs } from './botFaceMotionTokens';

/**
 * How long a hero's one moment lasts per mood: one cycle of the lab pose's own period (quiet's breath, two of working's
 * nods), the needs-you hop and the done moment (lab `DONE_MS`). Art timings, not limits: after them the face rests.
 */
export const BOT_FACE_MOMENT_MS: Readonly<Record<BotFaceMood, number>> = {
  quiet: 4800,
  working: 3200,
  needsYou: 600,
  done: 1900,
  failed: botFaceMomentMs('failed'),
};

/**
 * A hero plays one bounded moment when it appears and when its mood changes, then rests. It produces frames only while
 * `eligible` (visible surface, app viewed, reduced motion off); losing eligibility ends the moment at its resting pose,
 * and a moment missed while ineligible is not replayed. Returns ms into the moment, or null at rest. The frame clock
 * lives in this leaf only; parents never render per frame.
 */
export function useBotFaceMoment(
  mood: BotFaceMood,
  eligible: boolean,
  reactionsOnly = false,
): number | null {
  const [t, setT] = React.useState<number | null>(null);
  const duration = BOT_FACE_MOMENT_MS[mood];
  const seen = React.useRef(mood);
  const appeared = React.useRef(false);
  React.useEffect(() => {
    const changed = seen.current !== mood;
    seen.current = mood;
    if (!eligible) {
      if (changed) appeared.current = true;
      setT(null);
      return;
    }
    const appearance = !appeared.current;
    appeared.current = true;
    if (reactionsOnly ? !changed || mood === 'quiet' : !changed && !appearance) {
      setT(null);
      return;
    }
    let frame = 0;
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const elapsed = now - start;
      if (elapsed >= duration) {
        setT(null);
        return;
      }
      setT(elapsed);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [mood, duration, eligible, reactionsOnly]);
  return eligible ? t : null;
}
