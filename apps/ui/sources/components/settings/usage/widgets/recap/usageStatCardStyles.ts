import { PLANET_LIGHT_RAMP, PLANET_PALETTES } from '@happier-dev/brand/planet';
import { withUsageAccentAlpha } from '../../usageAccent';
import type { UsageRecapFormat, UsageRecapStyle } from './usageStatCardModel';

/**
 * The private stat card's named palette (an art-directed image, AGENTS "bounded art-directed
 * experience"): every colour comes from the Brand planet palette, the one owner of Daybreak art, so the
 * seven styles stay one family and follow the person's light/dark choice. Styles change art and ink
 * only; the facts and their layout are the one renderer's.
 */
export type UsageStatCardTone = 'light' | 'dark';
export type UsageStatCardArt =
  | 'planet'
  | 'sigil'
  | 'rules'
  | 'glass'
  | 'holo'
  | 'skyline'
  | 'terminal';
export type UsageStatCardPalette = Readonly<{
  art: UsageStatCardArt;
  background: string;
  /** Optional second background stop (top → bottom). */
  backgroundEnd?: string;
  ink: string;
  inkSecondary: string;
  inkFaint: string;
  rule: string;
  /** Category colours for mix bars and rings, in rank order. */
  series: readonly string[];
  /** A panel under the facts (Glass's frosted sheet, Holo's card). */
  panel?: Readonly<{ fill: string; border: string }>;
  mono: boolean;
  /** Headline weight: Editorial reads light and large, the rest semibold. */
  headlineWeight: 'regular' | 'semiBold';
}>;

const rgb = (value: readonly [number, number, number]) =>
  `#${value
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;

const PAPER = rgb(PLANET_PALETTES.light.background);
const NIGHT = rgb(PLANET_PALETTES.dark.background);
const SERIES = [
  PLANET_LIGHT_RAMP.warm,
  PLANET_LIGHT_RAMP.blush,
  PLANET_LIGHT_RAMP.violet,
  PLANET_LIGHT_RAMP.cool,
  PLANET_LIGHT_RAMP.deep,
];

function base(tone: UsageStatCardTone) {
  const palette = PLANET_PALETTES[tone];
  // Ink is the opposite planet background: warm paper on the night sky, deep night on paper.
  const ink = tone === 'dark' ? PAPER : NIGHT;
  return {
    background: palette.horizon.backgroundColor,
    ink,
    inkSecondary: withUsageAccentAlpha(ink, 0.66),
    inkFaint: withUsageAccentAlpha(ink, 0.38),
    rule: withUsageAccentAlpha(ink, 0.12),
    series: SERIES,
    mono: false,
    headlineWeight: 'semiBold' as const,
  };
}

export function resolveUsageStatCardPalette(
  style: UsageRecapStyle,
  tone: UsageStatCardTone,
): UsageStatCardPalette {
  const shared = base(tone);
  const dark = PLANET_PALETTES.dark;
  const light = PLANET_PALETTES.light;
  switch (style) {
    case 'daybreak':
      return { ...shared, art: 'planet' };
    case 'sigil':
      return { ...shared, art: 'sigil' };
    case 'editorial':
      return { ...shared, art: 'rules', headlineWeight: 'regular' };
    case 'glass': {
      const orb = tone === 'dark' ? dark.orb : light.orb;
      const ink = tone === 'dark' ? PAPER : NIGHT;
      return {
        ...shared,
        art: 'glass',
        background: orb.gold,
        backgroundEnd: tone === 'dark' ? dark.orb.plum : light.orb.plum,
        ink,
        inkSecondary: withUsageAccentAlpha(ink, 0.72),
        inkFaint: withUsageAccentAlpha(ink, 0.46),
        rule: withUsageAccentAlpha(ink, 0.18),
        panel: {
          fill: withUsageAccentAlpha(
            light.orb.veil,
            tone === 'dark' ? 0.12 : 0.42,
          ),
          border: withUsageAccentAlpha(
            light.orb.veil,
            tone === 'dark' ? 0.28 : 0.7,
          ),
        },
      };
    }
    case 'holo': {
      // A collector card: always the night sky, whatever the app's theme.
      const ink = PAPER;
      return {
        ...shared,
        art: 'holo',
        background: dark.orb.abyss,
        backgroundEnd: dark.horizon.backgroundColor,
        ink,
        inkSecondary: withUsageAccentAlpha(ink, 0.7),
        inkFaint: withUsageAccentAlpha(ink, 0.42),
        rule: withUsageAccentAlpha(ink, 0.14),
        panel: {
          fill: withUsageAccentAlpha(dark.orb.core, 0.18),
          border: withUsageAccentAlpha(dark.orb.amber, 0.55),
        },
      };
    }
    case 'skyline':
      return { ...shared, art: 'skyline' };
    case 'terminal': {
      const ink = tone === 'dark' ? PAPER : NIGHT;
      return {
        ...shared,
        art: 'terminal',
        background:
          tone === 'dark'
            ? dark.horizon.backgroundColor
            : light.horizon.backgroundColor,
        ink,
        inkSecondary: withUsageAccentAlpha(ink, 0.68),
        inkFaint: withUsageAccentAlpha(ink, 0.4),
        rule: withUsageAccentAlpha(ink, 0.16),
        mono: true,
        headlineWeight: 'regular',
      };
    }
  }
}

/** Logical card sizes; capture scales them by the device pixel ratio. */
export const USAGE_STAT_CARD_SIZES: Readonly<
  Record<UsageRecapFormat, Readonly<{ width: number; height: number }>>
> = {
  square: { width: 540, height: 540 },
  story: { width: 405, height: 720 },
  'link-preview': { width: 600, height: 315 },
};

/** Type scale relative to the card (an image at a fixed size, not app text). */
export const USAGE_STAT_CARD_TYPE = {
  caption: 13,
  headline: { square: 104, story: 96, 'link-preview': 72 },
  unit: 20,
  stat: 30,
  statLabel: 12,
  legend: 12,
  footer: 11,
} as const;

export const USAGE_STAT_CARD_STYLES: readonly UsageRecapStyle[] = [
  'daybreak',
  'sigil',
  'editorial',
  'glass',
  'holo',
  'skyline',
  'terminal',
];
