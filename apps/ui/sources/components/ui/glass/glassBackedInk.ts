import * as React from 'react';
import { Platform } from 'react-native';

import { parseThemeColor } from '@/theme/parseThemeColor';
import { picturePrefersPageInk } from '@happier-dev/brand/atmosphere-haze';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { GLASS_BACKED_FAINT_INK_SHARE } from './glassMaterial';
export { GLASS_BACKED_FAINT_INK_SHARE } from './glassMaterial';

export type GlassBackedInk = Readonly<{
  themeSecondary: string;
  secondary: string;
  /**
   * The theme's other quiet inks (tertiary meta, the composer's chips and placeholder) and the faint step they all
   * take on backed glass, the one the default coat cap protects (not on the picture plane, which uses `picture`).
   */
  quiet?: Readonly<{ themeInks: readonly string[]; ink: string }>;
  /** Only where the page itself is the picture: the theme's other quiet inks, and the ink they take there. */
  picture?: Readonly<{ themeInks: readonly string[]; ink: string }>;
}>;

/**
 * Set by GlassSurface on glass with a band, wallpaper or the live desktop behind it, and on the content
 * plane that has cleared over a Wallpaper (the picture is the page); null elsewhere.
 */
export const GlassBackedInkContext = React.createContext<GlassBackedInk | null>(
  null,
);

/**
 * The stronger faint ink for a backed material, derived from the theme's primary ink. Every quiet ink the theme
 * draws text in takes it: no text on backed glass is fainter than the step the coat cap keeps legible.
 */
export function resolveGlassBackedInk(
  primary: string,
  themeSecondary: string,
  themeQuietInks: readonly string[],
): GlassBackedInk {
  const faint = parseThemeColor(primary)?.alpha(GLASS_BACKED_FAINT_INK_SHARE).rgb().string();
  return {
    themeSecondary,
    secondary: faint ?? (Platform.OS === 'web' ? 'var(--colors-text-secondary)' : themeSecondary),
    ...(faint ? { quiet: { themeInks: themeQuietInks, ink: faint } } : null),
  };
}

/** The web stylesheet tokens of the theme's quiet inks, which backed glass redefines to its faint step. */
export const GLASS_QUIET_INK_WEB_TOKENS = ['--colors-text-secondary', '--colors-text-tertiary', '--colors-composer-chip-tint', '--colors-input-placeholder'] as const;

/** The theme's quiet inks besides the secondary (`GLASS_QUIET_INK_WEB_TOKENS` names their web tokens). */
export function glassQuietThemeInks(colors: Readonly<{ text: { tertiary: string }; composer: { chipTint: string }; input: { placeholder: string } }>): readonly string[] {
  return [colors.text.tertiary, colors.composer.chipTint, colors.input.placeholder];
}

/**
 * The inks of a content plane that has cleared over a Wallpaper: text there stands on the picture itself,
 * so its quiet lines (meta, section actions, their glyphs) read in the primary ink, as the lab's Wallpaper
 * heads do (`.at-wall .at-wsh`). Where the atmosphere chose the page colour for the plane (a person's own
 * night picture under the light theme), every ink on the plane, the primary included, reads in it instead.
 * Elements on that plane take their own material's ink again.
 */
export function resolveGlassPictureInk(
  input: Readonly<{
    primary: string;
    page: string;
    themeSecondary: string;
    themeQuietInks: readonly string[];
    /** The plane's ink as the atmosphere decided it with the haze (`GlassAtmosphereTone.ink`). */
    pictureInk?: 'theme' | 'page';
  }>,
): GlassBackedInk {
  const { primary, themeSecondary, themeQuietInks } = input;
  const ink = input.pictureInk === 'page' ? input.page : primary;
  return ink === primary
    ? { themeSecondary, secondary: primary, picture: { themeInks: themeQuietInks, ink: primary } }
    : { themeSecondary, secondary: ink, picture: { themeInks: [primary, ...themeQuietInks], ink } };
}

/**
 * Without the default haze to stand on (a person's own picture or look), the theme's ink stays while it keeps
 * large-text contrast on the picture. It turns to the page colour only where it fails even that (a night sky
 * under the light theme) and the page colour reaches body contrast. A mid-tone picture that defeats both
 * (bright sky over dark land) keeps the theme's ink. Used by the atmosphere's `resolveWallpaperHaze`.
 */
export function glassPictureInk(primary: string, page: string, pictureLuminance: number | undefined): string {
  if (pictureLuminance === undefined) return primary;
  const primaryColor = parseThemeColor(primary);
  const pageColor = parseThemeColor(page);
  if (primaryColor === null || pageColor === null) return primary;
  return picturePrefersPageInk(primaryColor.luminosity(), pageColor.luminosity(), pictureLuminance) ? page : primary;
}

/**
 * Ink adapters (Text, Icon) draw the theme's secondary token as the containing material's faint ink.
 * Callers pass the semantic token from JavaScript, which the web stylesheet scope cannot reach.
 */
export function useGlassBackedInk(): (
  color: string | undefined,
) => string | undefined {
  const ink = React.useContext(GlassBackedInkContext);
  return React.useCallback(
    (color: string | undefined) =>
      ink === null || color === undefined ? color
        : color === ink.themeSecondary ? ink.secondary
        : ink.quiet?.themeInks.includes(color) ? ink.quiet.ink
        : ink.picture?.themeInks.includes(color) ? ink.picture.ink
        : color,
    [ink],
  );
}

/**
 * The theme's own ink tokens for the web stylesheet scope, restored where something stands on its own paint
 * inside a subtree whose inks were rerouted (a surface or a filled control on the picture plane).
 */
export function glassThemeInkWebStyle(text: Readonly<{ primary: string; secondary: string; tertiary: string }>): Record<string, string> {
  return { '--colors-text-primary': text.primary, '--colors-text-secondary': text.secondary, '--colors-text-tertiary': text.tertiary };
}

/**
 * True where a control that paints its own fill (a filled or bordered button) sits on the picture plane:
 * it stands on that fill, not on the picture, so the picture's ink stops at its edge. The control resets
 * `GlassBackedInkContext` for its content (and, on web, the tokens of `glassThemeInkWebStyle`).
 */
export function useGlassOwnFillOnPicture(paintsFill: boolean): boolean {
  return React.useContext(GlassBackedInkContext)?.picture !== undefined && paintsFill;
}

/**
 * The ink a surface publishes to its text and icons. A surface rebuilds its ink whenever any theme or
 * environment input it lists moves, though most moves leave the ink's members equal; every Text and
 * Icon below re-renders on a new identity, so an equal ink keeps the one already published.
 */
export function useRetainedGlassBackedInk(ink: GlassBackedInk | null): GlassBackedInk | null {
  const published = React.useRef<GlassBackedInk | null>(null);
  published.current = ink === null ? null : retainIfEqual(published.current ?? undefined, ink);
  return published.current;
}
