import { createContext } from 'react';

/** Anything the host can measure against the facts' scroll content (a View ref on every platform). */
export type HappierFactsRevealTarget = Readonly<{
  measureLayout?: (
    relativeTo: unknown,
    onSuccess: (x: number, y: number, width: number, height: number) => void,
    onFail?: () => void,
  ) => void;
}>;

/**
 * A bounded approval prompt's reveal line: a fold that opens inside its scrolling facts (Technical details) hands
 * its opened body here, and the prompt scrolls just enough to bring that body into view instead of leaving it under
 * the decision and the edge fade (design review R4, 2026-11-25). Null outside a bounded prompt.
 */
export const HappierApprovalFactsRevealContext = createContext<
  ((target: HappierFactsRevealTarget | null) => void) | null
>(null);

/**
 * Where the facts scroll to show a body at `top`..`top + height` (content coordinates): the least move that brings
 * its end into the window, never past its own start, so a body taller than the window reads from its first line.
 * `null` when it is already in view.
 */
export function resolveHappierFactsRevealOffset(
  input: Readonly<{
    top: number;
    height: number;
    viewport: number;
    offset: number;
  }>,
): number | null {
  if (input.viewport <= 0) return null;
  let next = input.offset;
  if (input.top + input.height > next + input.viewport)
    next = input.top + input.height - input.viewport;
  if (input.top < next) next = input.top;
  next = Math.max(0, next);
  return Math.abs(next - input.offset) < 1 ? null : next;
}
