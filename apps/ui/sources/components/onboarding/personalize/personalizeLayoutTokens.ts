import { PLANET_PALETTES } from '@happier-dev/brand/planet';

/** Personalize Happier's narration column and its action rail. */
export const personalizeLayoutTokens = {
    narration: {
        width: 440,
        minWidth: 400,
        maxWidth: 460,
        dividerColor: { dark: PLANET_PALETTES.dark.horizon.dividerColor, light: PLANET_PALETTES.light.horizon.dividerColor },
    },
    action: {
        primaryHeight: 44,
        primaryRadius: 22,
        primaryPaddingHorizontal: 20,
        primaryFontSize: 15,
        trailingRailWidth: 136,
    },
} as const;
