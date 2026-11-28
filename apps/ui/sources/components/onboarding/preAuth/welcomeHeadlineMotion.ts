import type { StyleProp, TextStyle } from 'react-native';

import type { WelcomeHeadline } from './welcomeHeadlineModel';

export type WelcomeHeadlineProps = Readonly<{
  headline: WelcomeHeadline;
  /** The live Welcome (it may rotate); the opening's replica and other inert presentations stay on the first phrase. */
  interactive: boolean;
  /** The first and second lines' art-directed looks, owned by the Welcome. */
  lineStyle: StyleProp<TextStyle>;
  line2Style: StyleProp<TextStyle>;
}>;

/** One phrase stands this long before the next (website lab r10 `home.js`). */
export const WELCOME_HEADLINE_SWAP_INTERVAL_MS = 3200;
/** The words resolve over this long; the lead over four fifths of it. */
export const WELCOME_HEADLINE_SWAP_MS = 640;
/** The parts' move to their new places and their clips' ease to the new widths. */
export const WELCOME_HEADLINE_MOVE_CSS = {
  duration: '700ms',
  easing: 'cubic-bezier(.5, 0, .12, 1)',
} as const;

export function nextWelcomeHeadlineIndex(
  current: number,
  count: number,
): number {
  return count > 0 ? (current + 1) % count : 0;
}

/** Where the lead and the words start, from the line's centre, so the joined phrase stands centred. */
export function placeWelcomeHeadlinePhrase(
  widths: Readonly<{ lead: number; gap: number; vary: number }>,
): Readonly<{ leadX: number; varyX: number }> {
  const leadX = -(widths.lead + widths.gap + widths.vary) / 2;
  return { leadX, varyX: leadX + widths.lead + widths.gap };
}

const LOWER = 'abcdefghknopqrsuvxyz';
const UPPER = 'ABCDEGHKNOPRSUVXZ';

/**
 * One frame of a part's letters going from `from` to `to` at `progress` (0–1): they resolve left to right, each one
 * first flickering through random letters of its case.
 */
export function scrambleWelcomeHeadlineText(
  from: string,
  to: string,
  progress: number,
  random: () => number,
): string {
  if (progress >= 1) return to;
  const length = Math.max(from.length, to.length);
  const pick = (reference: string | undefined) => {
    // Only Latin letters flicker; any other character (punctuation, another script) settles as itself.
    if (reference && /[^A-Za-z]/.test(reference)) return reference;
    const set = reference && reference === reference.toUpperCase() ? UPPER : LOWER;
    return set[Math.floor(random() * set.length)]!;
  };
  let out = '';
  for (let i = 0; i < length; i++) {
    const settle = (i / length) * 0.62 + 0.38;
    if (progress >= settle) out += to[i] ?? '';
    else if (progress > settle - 0.36)
      out +=
        (to[i] === ' ' || from[i] === ' ') && progress > settle - 0.12
          ? ' '
          : pick(to[i] ?? from[i]);
    else out += from[i] ?? '';
  }
  return out;
}
