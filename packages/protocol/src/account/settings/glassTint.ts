import * as z from 'zod/mini';

export const DEFAULT_GLASS_TINT_INTENSITY = 12;
export const GlassTintIntensitySchema = z.number().check(z.int(), z.minimum(0), z.maximum(100));

export type GlassTintValues = Readonly<{
    cardCoat: number;
    clearCardCoat: number;
    floatingCoat: number;
    panelCoat: number;
    /** The notch's ink glass: its own anchor at the shipped default, so Tint moves smoothly through it. */
    notchCoat: number;
    plainDarkCompression: number;
    pictureDarkCompression: number;
    lightCompression: number;
}>;

const NOTCH_COAT = { atClear: 0.55, atDefault: 0.95, atOpaque: 1 } as const;

function resolveNotchCoat(tint: number): number {
    return tint <= DEFAULT_GLASS_TINT_INTENSITY
        ? NOTCH_COAT.atClear + (NOTCH_COAT.atDefault - NOTCH_COAT.atClear) * tint / DEFAULT_GLASS_TINT_INTENSITY
        : NOTCH_COAT.atDefault + (NOTCH_COAT.atOpaque - NOTCH_COAT.atDefault) * (tint - DEFAULT_GLASS_TINT_INTENSITY) / (100 - DEFAULT_GLASS_TINT_INTENSITY);
}

/** Named materials share these anchors; card and floating use the same compression in both themes. */
const GLASS_TINT_ANCHORS = {
    0: { cardCoat: 0.01, clearCardCoat: 0.01, floatingCoat: 0.01, panelCoat: 0.55,
        plainDarkCompression: 1, pictureDarkCompression: 1, lightCompression: 1 },
    50: { cardCoat: 0.25, clearCardCoat: 0.15, floatingCoat: 0.02, panelCoat: 0.7,
        plainDarkCompression: 1, pictureDarkCompression: 0.45, lightCompression: 0.43 },
    100: { cardCoat: 0.45, clearCardCoat: 0.3, floatingCoat: 0.25, panelCoat: 0.85,
        plainDarkCompression: 0.7, pictureDarkCompression: 0.35, lightCompression: 0.3 },
} as const satisfies Record<0 | 50 | 100, Omit<GlassTintValues, 'notchCoat'>>;

/** Stored missing/malformed values recover to the default; mutations use the strict schema. */
export function readGlassTintIntensity(value: unknown): number {
    const parsed = GlassTintIntensitySchema.safeParse(value);
    return parsed.success ? parsed.data : DEFAULT_GLASS_TINT_INTENSITY;
}

/** Piecewise linear tint mapping, shared by settings coats and the web fixed-point renderer. */
export function resolveGlassTintValues(value: unknown): GlassTintValues {
    const tint = readGlassTintIntensity(value);
    const lower = GLASS_TINT_ANCHORS[tint <= 50 ? 0 : 50];
    const upper = GLASS_TINT_ANCHORS[tint <= 50 ? 50 : 100];
    const fraction = (tint - (tint <= 50 ? 0 : 50)) / 50;
    const interpolate = (key: keyof typeof lower) => lower[key] + (upper[key] - lower[key]) * fraction;
    return {
        cardCoat: interpolate('cardCoat'),
        clearCardCoat: interpolate('clearCardCoat'),
        floatingCoat: interpolate('floatingCoat'),
        panelCoat: interpolate('panelCoat'),
        notchCoat: resolveNotchCoat(tint),
        plainDarkCompression: interpolate('plainDarkCompression'),
        pictureDarkCompression: interpolate('pictureDarkCompression'),
        lightCompression: interpolate('lightCompression'),
    };
}
