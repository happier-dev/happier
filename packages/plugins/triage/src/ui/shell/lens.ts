import {
  MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
  type TriageListLensV1,
} from '../../projection/listWindow.js';
import type { TriageSurfaceStateV1 } from '../state/surface.js';

/**
 * The one place the reducer's lens becomes the window's lens.
 *
 * `core/SURFACE.md` §3.1 keeps order, the five facets and the Smart precedence
 * in one reducer, and `projection/listWindow.ts` owns the lens every consumer of
 * the shared window reads through. This function is the seam between them, and
 * it exists so there is exactly one: the shareable location
 * (`ui/navigation/location.ts#readTriageRouteLensV1`) and the rows on screen are
 * then two readings of the same state rather than two lenses that can disagree
 * about what the reader is looking at.
 *
 * It is a projection and nothing else. It holds no state, decides no default,
 * and takes the row bound from the window owner rather than naming a second
 * number — a shell-local limit would be a second answer to how large one window
 * is, and the derivation that keeps that count inside the transport gate lives
 * with the owner (`actions/maximumEncodedActionValue.test.ts`).
 */
export function readTriageWindowLensV1(state: TriageSurfaceStateV1, nowMs = Date.now()): TriageListLensV1 {
  const weekStart = new Date(nowMs);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
  return Object.freeze({
    ...(state.filters.tasks === undefined ? {} : { tasks: { completedSinceMs: weekStart.getTime() } }),
    order: state.order,
    ...(state.sort === undefined ? {} : { sort: state.sort }),
    smartPolicy: state.smartPolicy,
    // The settled query only. An IME-intermediate composition would rebuild the
    // window on half-typed text (`core/SURFACE.md` §6).
    query: state.search.query,
    filters: state.filters,
    limit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
  });
}
