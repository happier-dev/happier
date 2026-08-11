/**
 * The `text.*` and `surface.*` palettes — one owner for the two blocks every screen reads.
 *
 * Same arrangement, and same reason, as `theme/tokens/stateColors.ts`: the Vitest unistyles mock
 * (`sources/dev/vitestSetup.ts`) serves the theme to every rendered component and cannot import the
 * real theme, because 450+ test files install their own partial `react-native` mock against which
 * `theme/index.ts`'s `Platform.select` calls would throw. This module therefore imports nothing at
 * all, so both the real theme and the mock can consume the same bytes.
 *
 * Neither block has a platform-split value, so unlike `stateColors.ts` there is no pair to select
 * from — the values below are the whole contract.
 *
 * `sources/dev/vitestSetupThemeParity.test.ts` is the guard. It was added for `state.*` after a
 * hand-copied hue was found serving `#5856D6` where the app paints `#5C6BC0`; extending it here
 * caught seven more of exactly that defect — `text.primary` (`#000000` vs `#222222`),
 * `text.secondary` (`#666666` vs `#6c6c70`), `text.tertiary` (`#999999` vs `#99999d`),
 * `surface.pressed` / `surface.pressedOverlay` (`#f0f0f2` vs `#fafafa`), `surface.selected`
 * (`#f2f2f2` vs `#f8f8f8`) and `surface.sectionTint` (2.2% vs 1.2% black). Every one of those
 * rendered a colour the app never paints, in every suite that did not bring its own theme.
 */

export type ThemeTextColors = Readonly<{
    primary: string;
    secondary: string;
    tertiary: string;
    link: string;
    destructive: string;
    placeholder: string;
    disabled: string;
}>;

export type ThemeSurfaceColors = Readonly<{
    base: string;
    inset: string;
    elevated: string;
    ripple: string;
    pressed: string;
    selected: string;
    pressedOverlay: string;
    sectionTint: string;
}>;

export const lightTextColors: ThemeTextColors = {
    primary: '#222222',
    secondary: '#6c6c70',
    tertiary: '#99999d',
    link: '#2BACCC',
    destructive: '#FF3B30',
    placeholder: '#999999',
    disabled: '#C0C0C0',
};

export const darkTextColors: ThemeTextColors = {
    primary: '#EFEFEF',
    secondary: '#8A817C',
    tertiary: '#6C625D',
    link: '#9EB9FF',
    destructive: '#EE6E6C',
    placeholder: '#766C67',
    disabled: '#635955',
};

export const lightSurfaceColors: ThemeSurfaceColors = {
    base: '#ffffff',
    inset: '#F8F8F8',
    elevated: '#f0f0f0',
    ripple: 'rgba(0, 0, 0, 0.08)',
    pressed: '#fafafa',
    selected: '#f8f8f8',
    pressedOverlay: '#fafafa',
    // Barely-there grouped-section tint. Baked as an opacity overlay (not a solid inset) so it
    // reads a hair off the base surface; a runtime opacity transform would be a silent no-op once
    // web var-ifies the token.
    sectionTint: 'rgba(0,0,0,0.012)',
};

export const darkSurfaceColors: ThemeSurfaceColors = {
    base: '#191717',
    inset: '#171515',
    elevated: '#221C1C',
    ripple: 'rgba(255, 255, 255, 0.055)',
    pressed: '#302727',
    selected: '#292121',
    pressedOverlay: 'rgba(255,255,255,0.036)',
    sectionTint: 'rgba(255,255,255,0.014)',
};
