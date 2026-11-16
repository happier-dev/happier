import { useOptionalHappierUiTypography } from '../../environment/context.js';
import type {
  HappierTypeRole,
  HappierUiTheme,
  HappierUiTypography,
} from '../../environment/types.js';
import type { HappierFontWeight, HappierPortableStyle } from '../portableTypes.js';
import { Platform } from 'react-native';
import { HAPPIER_TYPE_WEIGHT, resolveHappierTypeScale, type HappierTypeEmphasis } from './typeScale.js';

/**
 * The one resolver from a type role to a text style for every shared text
 * owner (Text variants, Heading, Label, list rows, status lines, form fields).
 *
 * A same-realm host supplies the active font faces. Hosted surfaces resolve
 * the same table directly; the public snapshot retains its historical keys
 * and is a projection, never a second metric owner.
 */
export function resolveHappierTypeRoleStyle(
  role: HappierTypeRole,
  theme: HappierUiTheme | null,
  typography: HappierUiTypography | null,
  emphasis?: HappierTypeEmphasis,
): HappierPortableStyle {
  const host = typography?.[role];
  const face = emphasis ? typography?.weights?.[emphasis] : undefined;
  if (host) {
    const font = emphasis
      ? { fontFamily: face?.fontFamily, fontWeight: face?.fontWeight as HappierFontWeight | undefined ?? (face?.fontFamily ? undefined : HAPPIER_TYPE_WEIGHT[emphasis]) }
      : { fontFamily: host.fontFamily, fontWeight: host.fontWeight as HappierFontWeight | undefined };
    return {
      fontSize: host.fontSize,
      lineHeight: host.lineHeight,
      ...(font.fontWeight === undefined ? {} : { fontWeight: font.fontWeight }),
      ...(font.fontFamily === undefined ? {} : { fontFamily: font.fontFamily }),
      ...(host.letterSpacing === undefined ? {} : { letterSpacing: host.letterSpacing }),
    };
  }
  const metric = resolveHappierTypeScale(role, Platform.OS, emphasis);
  const projected = role === 'display' || role === 'title' || role === 'heading'
    ? theme?.typography.title : role === 'meta' || role === 'micro'
      ? theme?.typography.caption : theme?.typography[role];
  const family = projected?.fontFamily ?? theme?.typography.body.fontFamily;
  return {
    fontSize: metric.fontSize,
    lineHeight: metric.lineHeight,
    fontWeight: HAPPIER_TYPE_WEIGHT[metric.weight],
    letterSpacing: metric.letterSpacing,
    ...(family ? { fontFamily: family } : {}),
  };
}

/** {@link resolveHappierTypeRoleStyle} with the environment's host facts. */
export function useHappierTypeRoleStyle(role: HappierTypeRole, theme: HappierUiTheme): HappierPortableStyle {
  return resolveHappierTypeRoleStyle(role, theme, useOptionalHappierUiTypography());
}

/**
 * Whether the host draws this role with tabular figures. `fontVariant` is an
 * app-private React Native text style, outside the portable author vocabulary,
 * so it travels as this fact to the one text owner rather than as a style.
 */
export function readHappierTypeRoleTabular(
  role: HappierTypeRole,
  typography: HappierUiTypography | null,
): boolean {
  return typography?.[role]?.fontVariant?.includes('tabular-nums') === true;
}
