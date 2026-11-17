import type { SupportedLanguage } from '../_all';

/** Appearance → Sessions: "Highlight sessions that need you" (owner ruling 2026-11-01). */
export type NeedsYouHighlightCopy = Readonly<{ title: string; description: string; dot: string; accent: string; glint: string; shimmer: string; pulse: string }>;

export const needsYouHighlightTranslations = {
  en: { title: 'Highlight sessions that need you', description: 'How a session that needs you stands out in the list on this device. Motion stops once you open it.', dot: 'Dot', accent: 'Accent', glint: 'Glint', shimmer: 'Shimmer', pulse: 'Pulse' },
} as const satisfies Pick<Record<SupportedLanguage, NeedsYouHighlightCopy>, 'en'>;

/** Appearance → Sessions: the restored 0.2 working indicator and playful working words (owner amendment 2026-11-01). */
export type WorkingIndicatorCopy = Readonly<{ title: string; description: string; spinner: string; pulse: string; animatedTextTitle: string; animatedTextDescription: string }>;

export const workingIndicatorTranslations = {
  en: { title: 'Working indicator', description: 'How a working session shows in the list.', spinner: 'Spinner', pulse: 'Pulsing dot', animatedTextTitle: 'Playful working words', animatedTextDescription: 'With status words on, a working session shows a playful word instead of “Working”.' },
} as const satisfies Pick<Record<SupportedLanguage, WorkingIndicatorCopy>, 'en'>;
