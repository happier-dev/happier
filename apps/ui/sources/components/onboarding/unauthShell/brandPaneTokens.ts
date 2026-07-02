import { useUnistyles } from 'react-native-unistyles';

/**
 * Brand-art exception colors for the unauthenticated onboarding left pane.
 *
 * The brand pane is a controlled website-derived art surface (planet JPG +
 * tagline + trust strip) that follows the same dark/light treatment as the
 * marketing site hero:
 *   - Dark theme → dark canvas + light planet variant + white-on-dark text.
 *   - Light theme → cream paper canvas + warm planet variant + dark-on-cream text.
 *
 * These are the only allowed hard-coded color literals in the unauth onboarding
 * components. All workflow-pane and step-body colors must continue to come
 * from `theme.colors.*` via `useUnistyles()`.
 *
 * Components should consume `useBrandPaneTokens()` at runtime so the palette
 * flips with the user's theme. The named constants are kept for legacy tests
 * that import statically and for non-React asset paths; they snapshot the
 * dark palette (the brand pane was always-dark in earlier drafts).
 */

export type BrandPaneTokens = Readonly<{
    background: string;
    foreground: string;
    foregroundMuted: string;
    foregroundSoft: string;
    /** Transparent variant of `background`, useful as the start stop of fades. */
    backgroundTransparent: string;
}>;

// Background colors are sampled from the TOP edge of the planet JPGs
// (`apps/ui/sources/assets/onboarding/planet-{dark,light}.jpg`). The planet
// image is rendered as an oversized backdrop whose visible window may not
// cover the full pane on every aspect ratio — picking the planet's own
// top-edge color means the surrounding canvas blends seamlessly with the
// image instead of revealing a contrasting grey/cream band above it.
const DARK_TOKENS: BrandPaneTokens = {
    // Top-edge of planet-dark.jpg: nearly pure black with a faint cool
    // undertone from the texture noise pattern.
    background: '#040408',
    foreground: '#FFFFFF',
    foregroundMuted: 'rgba(255, 255, 255, 0.55)',
    foregroundSoft: 'rgba(255, 255, 255, 0.72)',
    backgroundTransparent: 'rgba(4, 4, 8, 0)',
};

const LIGHT_TOKENS: BrandPaneTokens = {
    // Top-edge of planet-light.jpg: near-white with a barely-there warm
    // undertone. Replaces the previous cream `#F7F5F0` which contrasted
    // visibly with the planet image's near-white top.
    background: '#FBFAF9',
    foreground: '#0A0A0A',
    foregroundMuted: 'rgba(10, 10, 10, 0.55)',
    foregroundSoft: 'rgba(10, 10, 10, 0.72)',
    backgroundTransparent: 'rgba(251, 250, 249, 0)',
};

/**
 * Theme-aware brand-pane palette. Returns the dark set when `theme.dark` is
 * true, the light set otherwise.
 */
export function useBrandPaneTokens(): BrandPaneTokens {
    const { theme } = useUnistyles();
    return theme.dark ? DARK_TOKENS : LIGHT_TOKENS;
}

// Legacy snapshot constants (dark palette). Kept for callers that read the
// brand-art exception colors statically — primarily Vitest tests that assert
// the rgba string for the on-dark provider mark tint.
export const BRAND_PANE_BACKGROUND = DARK_TOKENS.background;
export const BRAND_PANE_FOREGROUND = DARK_TOKENS.foreground;
export const BRAND_PANE_FOREGROUND_MUTED = DARK_TOKENS.foregroundMuted;
export const BRAND_PANE_FOREGROUND_SOFT = DARK_TOKENS.foregroundSoft;
