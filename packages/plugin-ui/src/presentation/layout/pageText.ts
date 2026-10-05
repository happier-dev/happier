import { Platform } from 'react-native';

import type { HappierUiTypography } from '../../environment/types.js';
import type { HappierFontWeight, HappierPortableStyle } from '../portableTypes.js';

/** The weights the configuration-page anatomy draws with. */
export type HappierPageTextWeight = 'regular' | 'medium' | 'semiBold' | 'bold';

/**
 * The text steps of the configuration-page anatomy: the page title and its
 * purpose line, the meta line, a section's title and description, and a page
 * row's title and description.
 */
export type HappierPageTextRole =
  | 'pageTitle'
  | 'heroTitle'
  | 'pageDescription'
  | 'meta'
  | 'sectionTitle'
  | 'sectionDescription'
  | 'rowTitle'
  | 'rowDescription';

export type HappierPageTextStep = Readonly<{
  weight: HappierPageTextWeight;
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
}>;

const ios = Platform.OS === 'ios';

/**
 * The one owner of the page anatomy's type scale, for Happier core pages
 * (which add their own font family per weight) and plugin pages (which take
 * the family from the host's typography facts, else a numeric weight).
 *
 * The page row title is the anatomy's default (cozy) step; Happier core rows
 * additionally follow the user's list-density preference through their own
 * density owner.
 */
export const HAPPIER_PAGE_TEXT: Readonly<Record<HappierPageTextRole, HappierPageTextStep>> = Object.freeze({
  pageTitle: { weight: 'bold', fontSize: 22, lineHeight: 28, letterSpacing: -0.4 },
  heroTitle: { weight: 'bold', fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  pageDescription: { weight: 'regular', fontSize: 14, lineHeight: 20 },
  meta: { weight: 'regular', fontSize: 13, lineHeight: 18 },
  sectionTitle: { weight: 'bold', fontSize: ios ? 15 : 14, lineHeight: 20, letterSpacing: -0.1 },
  sectionDescription: { weight: 'regular', fontSize: 13, lineHeight: 18 },
  rowTitle: { weight: 'medium', fontSize: ios ? 15 : 14, lineHeight: 20, letterSpacing: ios ? -0.3 : 0.12 },
  rowDescription: { weight: 'regular', fontSize: 13, lineHeight: 18, letterSpacing: 0 },
});

/** A step's size, line height and tracking, without a weight (core adds its own family). */
export function happierPageTextMetrics(role: HappierPageTextRole): Readonly<{
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
}> {
  const step = HAPPIER_PAGE_TEXT[role];
  return step.letterSpacing === undefined
    ? { fontSize: step.fontSize, lineHeight: step.lineHeight }
    : { fontSize: step.fontSize, lineHeight: step.lineHeight, letterSpacing: step.letterSpacing };
}

const NUMERIC_WEIGHT: Readonly<Record<HappierPageTextWeight, HappierFontWeight>> = Object.freeze({
  regular: '400',
  medium: '500',
  semiBold: '600',
  bold: '700',
});

/**
 * A page text step as a complete style: the host's family for the step's
 * weight when it installs one (a same-realm host's Inter-Medium, say),
 * otherwise the numeric weight.
 */
export function resolveHappierPageTextStyle(
  role: HappierPageTextRole,
  typography: HappierUiTypography | null,
): HappierPortableStyle {
  return resolveHappierTextStepStyle(HAPPIER_PAGE_TEXT[role], typography);
}

/**
 * Any shared text step (a page step, a tile label) as a complete style: its
 * metrics plus the host's face for its weight, else a numeric weight.
 */
export function resolveHappierTextStepStyle(
  step: HappierPageTextStep,
  typography: HappierUiTypography | null,
): HappierPortableStyle {
  const face = typography?.weights?.[step.weight];
  return {
    fontSize: step.fontSize,
    lineHeight: step.lineHeight,
    ...(step.letterSpacing === undefined ? {} : { letterSpacing: step.letterSpacing }),
    ...(face
      ? {
          ...(face.fontFamily === undefined ? {} : { fontFamily: face.fontFamily }),
          ...(face.fontWeight === undefined ? {} : { fontWeight: face.fontWeight as HappierFontWeight }),
        }
      : { fontWeight: NUMERIC_WEIGHT[step.weight] }),
  };
}
