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
export type HappierTextVariant = 'body' | 'label' | 'title' | 'caption' | 'code';

export type HappierTone =
  | 'neutral'
  | 'secondary'
  | 'muted'
  | 'info'
  | 'success'
  | 'warning'
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
  danger: 'danger',
  accent: 'accent',
} as const satisfies Record<HappierTone, string>;
