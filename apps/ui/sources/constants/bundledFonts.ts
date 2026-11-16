import type { FontSource } from 'expo-font';

/** The text faces registered at app boot on native and web. Asset loading stays lazy for Metro. */
export const BUNDLED_FONTS = {
    inter: {
        label: 'Inter',
        faces: {
            regular: { family: 'Inter-Regular', asset: () => require('@/assets/fonts/Inter-Regular.ttf') as FontSource },
            italic: { family: 'Inter-Italic', asset: () => require('@/assets/fonts/Inter-Italic.ttf') as FontSource },
            medium: { family: 'Inter-Medium', asset: () => require('@/assets/fonts/Inter-Medium.ttf') as FontSource },
            semiBold: { family: 'Inter-SemiBold', asset: () => require('@/assets/fonts/Inter-SemiBold.ttf') as FontSource },
        },
    },
    plexMono: {
        label: 'IBM Plex Mono',
        faces: {
            regular: { family: 'IBMPlexMono-Regular', asset: () => require('@/assets/fonts/IBMPlexMono-Regular.ttf') as FontSource },
            italic: { family: 'IBMPlexMono-Italic', asset: () => require('@/assets/fonts/IBMPlexMono-Italic.ttf') as FontSource },
            semiBold: { family: 'IBMPlexMono-SemiBold', asset: () => require('@/assets/fonts/IBMPlexMono-SemiBold.ttf') as FontSource },
        },
    },
    bricolage: {
        label: 'Bricolage Grotesque',
        faces: { bold: { family: 'BricolageGrotesque-Bold', asset: () => require('@/assets/fonts/BricolageGrotesque-Bold.ttf') as FontSource } },
    },
    spaceMono: {
        label: 'Space Mono',
        faces: { regular: { family: 'SpaceMono', asset: () => require('@/assets/fonts/SpaceMono-Regular.ttf') as FontSource } },
    },
} as const;

type BundledFont = typeof BUNDLED_FONTS[keyof typeof BUNDLED_FONTS];
type FontFace<T> = T extends { faces: infer Faces } ? Faces[keyof Faces] : never;
type FontFaceWeight<T> = T extends { faces: infer Faces } ? keyof Faces : never;
export type BundledFontFamily = FontFace<BundledFont>['family'];
export type BundledTypefaceWeight = FontFaceWeight<BundledFont>;
export type BundledTypefaceChoice = Readonly<{ id: BundledFontFamily; label: string }>;

/** A selected family uses its loaded face for the requested emphasis, then its default face. */
export function resolveBundledTypefaceFace(family: string, weight: BundledTypefaceWeight): BundledFontFamily | null {
    const font = Object.values(BUNDLED_FONTS).find(candidate =>
        Object.values(candidate.faces).some(face => face.family === family));
    if (!font) return null;
    const faces: Readonly<Partial<Record<BundledTypefaceWeight, Readonly<{ family: BundledFontFamily }>>>> = font.faces;
    const requested = weight === 'bold' && faces.semiBold ? 'semiBold' : weight;
    return faces[requested]?.family ?? Object.values(font.faces)[0]!.family;
}

/** Each family's first face is its default choice (the logo family has only its bold face). */
export const BUNDLED_THEME_TYPEFACES: readonly BundledTypefaceChoice[] = Object.freeze(
    Object.values(BUNDLED_FONTS).map(font => Object.freeze({ id: Object.values(font.faces)[0]!.family, label: font.label })),
);

/** Boot and the typeface picker derive their names from this same asset owner. */
export function loadBundledFontAssets(): Record<string, FontSource> {
    return Object.fromEntries(Object.values(BUNDLED_FONTS).flatMap(font =>
        Object.values(font.faces).map(face => [face.family, face.asset()])));
}
