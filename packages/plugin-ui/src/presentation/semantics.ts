/**
 * The shared semantic vocabulary for Happier presentation.
 *
 * Deliberately its own module with NO React Native import. The plugin-facing
 * adapters reference these unions, so keeping them here is what stops the
 * package's author-facing declaration graph from reaching `react-native` types.
 * An external author writing a hosted-web or declarative plugin never installs
 * React Native, and their typecheck must not demand it.
 *
 * It lives at the presentation root rather than under `text/` because tone is
 * NOT a text concept: text, status indicators, spinners and state surfaces all
 * project the same semantic role onto the same canonical theme colour. Two
 * families each owning a tone→token table would disagree the first time either
 * changed.
 */
import type { HappierUiTheme } from '../environment/types.js';
import type { HappierTypeRole } from './text/typeScale.js';
export type HappierTextVariant = HappierTypeRole | 'code';

export type HappierTone =
  | 'neutral'
  | 'secondary'
  | 'muted'
  | 'info'
  | 'success'
  | 'warning'
  | 'attention'
  | 'danger'
  | 'accent';

/**
 * Which canonical theme colour each tone projects. Declared once so every
 * shared family and every adapter cannot disagree about what "danger" means.
 */
export const HAPPIER_TONE_COLOR_TOKEN = {
  neutral: 'text',
  secondary: 'secondaryText',
  muted: 'mutedText',
  info: 'info',
  success: 'success',
  warning: 'warning',
  /** "Needs you" — the host's attention ink; `warning` stays a caution. */
  attention: 'attention',
  danger: 'danger',
  accent: 'accent',
} as const satisfies Record<HappierTone, string>;

/**
 * A colour a person picks for a mark (a label's dot, its swatch in a colour menu): a theme tone, or a named hue
 * no semantic tone carries — `accent` is the host's control ink and can be black, and `info` can be blue.
 */
export type HappierMarkColor = HappierTone | 'blue' | 'purple';

export function resolveHappierMarkColor(theme: Readonly<{ colors: HappierUiTheme['colors'] }>, color: HappierMarkColor): string {
  // A host that predates the projected hues keeps the earlier ink (blue drew the accent, purple the info tone).
  if (color === 'blue') return theme.colors.blue ?? theme.colors.accent;
  if (color === 'purple') return theme.colors.purple ?? theme.colors.info;
  return theme.colors[HAPPIER_TONE_COLOR_TOKEN[color]];
}
