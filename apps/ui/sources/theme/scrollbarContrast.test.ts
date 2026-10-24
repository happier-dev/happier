import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';
import { compositeThemeColorOver, parseThemeColor, themeContrastRatio } from '@/theme/themeContrastMath';
import { resolveThemeColorTokenBaseValue } from '@/theme/tokens/themeColorTokenDefinitions';

/**
 * WCAG 2.2 SC 1.4.11: the web scrollbar thumb is a non-text control and must clear 3:1 against
 * its track while at rest, not only once the pointer is already on it.
 */
const SCROLLBAR_THUMB_MIN_RATIO = 3;

const themeCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'theme.css'), 'utf8');

function cssVarToTokenId(cssVar: string): string {
    const match = cssVar.match(/^--colors-([a-z]+)-([a-z]+)$/);
    if (!match) throw new Error(`Unsupported theme color variable "${cssVar}"`);
    return `${match[1]}.${match[2]}`;
}

function readRuleBackgroundVar(selector: string): string {
    const rule = themeCss.split(`\n${selector} {`)[1]?.split('}')[0];
    if (rule === undefined) throw new Error(`theme.css has no "${selector}" rule`);
    const cssVar = rule.match(/background:\s*var\((--[a-z-]+)\)/)?.[1];
    if (!cssVar) throw new Error(`"${selector}" has no themed background`);
    return cssVar;
}

function readFirefoxScrollbarColorVars(): readonly [string, string] {
    const match = themeCss.match(/scrollbar-color:\s*var\((--[a-z-]+)\)\s+var\((--[a-z-]+)\)/);
    if (!match) throw new Error('theme.css has no themed scrollbar-color declaration');
    return [match[1], match[2]];
}

const SCROLLBARS = {
    webkit: [readRuleBackgroundVar('::-webkit-scrollbar-thumb'), readRuleBackgroundVar('::-webkit-scrollbar-track')],
    firefox: readFirefoxScrollbarColorVars(),
} as const;

const THEMES = [
    ['light', lightTheme],
    ['dark', darkTheme],
] as const;

function readToken(theme: typeof lightTheme, tokenId: string): string {
    const value = resolveThemeColorTokenBaseValue(theme, tokenId);
    if (value === undefined) {
        throw new Error(`Theme color token "${tokenId}" is not registered or does not resolve to a color`);
    }
    return value;
}

describe('web scrollbar thumb contrast', () => {
    for (const [themeName, theme] of THEMES) {
        for (const [engine, [thumbVar, trackVar]] of Object.entries(SCROLLBARS)) {
            it(`${themeName}: ${engine} resting thumb is visible against its track`, () => {
                // The track sits on the canvas, and a translucent thumb is painted over that track.
                const track = compositeThemeColorOver(
                    parseThemeColor(readToken(theme, cssVarToTokenId(trackVar))),
                    parseThemeColor(readToken(theme, 'background.canvas')),
                );
                const thumb = compositeThemeColorOver(parseThemeColor(readToken(theme, cssVarToTokenId(thumbVar))), track);
                const ratio = themeContrastRatio(thumb, track);

                // WCAG 1.4.11 forbids rounding a computed ratio up to the threshold.
                expect(ratio, `${thumbVar} on ${trackVar}`).toBeGreaterThanOrEqual(
                    SCROLLBAR_THUMB_MIN_RATIO,
                );
            });
        }
    }
});
