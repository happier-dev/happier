import {
    DEFAULT_FONT_WEIGHTS,
    MONO_FONT_WEIGHTS,
    getHappierFontFamily,
    themeFontFamilyVariableName,
} from '@/constants/Typography';
import { runtimeWebFontFaceFamily } from '@/platform/installWebFontFaces';
import { resolveBundledTypefaceFace } from '@/constants/bundledFonts';

import type { ThemeStyleScales } from './themeStyleScales';

function quoteFamily(family: string): string {
    return `"${family.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

type RootStyle = Readonly<{
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => unknown;
}>;

function resolveRootStyle(): RootStyle | null {
    if (typeof document === 'undefined') return null;
    return document.documentElement?.style ?? null;
}

/**
 * Web: writes the theme-held families into the root variables every text style reads through
 * (`themeFontFamilyVariableName`). Each value keeps the Happier family last, and the default family
 * also names the runtime face aliases first (`installRuntimeWebFontFace`): when that face is absent
 * or fails to load, the browser falls through to the named family and then to Happier's. A `null`
 * family removes the variable, which restores today's rendering exactly.
 */
export function applyThemeFontFamilyVariables(
    typography: ThemeStyleScales['typography'],
    rootStyle: RootStyle | null = resolveRootStyle(),
): void {
    if (!rootStyle) return;
    for (const weight of DEFAULT_FONT_WEIGHTS) {
        const name = themeFontFamilyVariableName('default', weight);
        if (typography.fontFamily === null) {
            rootStyle.removeProperty(name);
            continue;
        }
        rootStyle.setProperty(name, [
            quoteFamily(runtimeWebFontFaceFamily(weight)),
            quoteFamily(resolveBundledTypefaceFace(typography.fontFamily, weight) ?? typography.fontFamily),
            getHappierFontFamily('default', weight),
        ].join(', '));
    }
    for (const weight of MONO_FONT_WEIGHTS) {
        const name = themeFontFamilyVariableName('mono', weight);
        if (typography.monoFontFamily === null) {
            rootStyle.removeProperty(name);
            continue;
        }
        rootStyle.setProperty(name, `${quoteFamily(typography.monoFontFamily)}, ${getHappierFontFamily('mono', weight)}`);
    }
}
