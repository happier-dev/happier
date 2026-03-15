import type { ThemeRegistration } from 'shiki';

import { lightTheme, darkTheme } from '@/theme';

type HappierThemeLike = typeof lightTheme;

function withStableId<T extends object>(value: T, id: string): T {
    Object.defineProperty(value, 'toString', {
        value: () => id,
        enumerable: false,
        configurable: true,
    });

    Object.defineProperty(value, Symbol.toPrimitive, {
        value: () => id,
        enumerable: false,
        configurable: true,
    });

    return value;
}

function toHex6(value: string): string {
    const raw = String(value ?? '').trim();
    if (!raw) return '#000000';
    // Some platforms use 8-digit hex; Shiki/Pierre are tolerant, but strip alpha for consistency.
    if (/^#[0-9a-fA-F]{8}$/.test(raw)) return raw.slice(0, 7);
    return raw;
}

function buildHappierTextMateTheme(params: Readonly<{ id: string; type: 'light' | 'dark'; theme: HappierThemeLike }>): ThemeRegistration {
    const colors = params.theme.colors as any;
    const bg = toHex6(colors?.surfaceHigh ?? colors?.surface ?? '#000000');
    const fg = toHex6(colors?.syntaxDefault ?? colors?.text ?? '#ffffff');

    const keyword = toHex6(colors?.syntaxKeyword ?? fg);
    const string = toHex6(colors?.syntaxString ?? fg);
    const number = toHex6(colors?.syntaxNumber ?? fg);
    const comment = toHex6(colors?.syntaxComment ?? colors?.textSecondary ?? fg);
    const func = toHex6(colors?.syntaxFunction ?? keyword);
    const punctuation = toHex6(colors?.syntaxComment ?? fg);

    return withStableId(
        {
            name: params.id,
            type: params.type,
            colors: {
                'editor.background': bg,
                'editor.foreground': fg,
            },
            tokenColors: [
                // Comments
                {
                    scope: ['comment', 'punctuation.definition.comment', 'comment.documentation'],
                    settings: { foreground: comment },
                },
                // Strings
                {
                    scope: ['string', 'punctuation.definition.string', 'string.quoted', 'markup.inline.raw.string.markdown'],
                    settings: { foreground: string },
                },
                // Numbers / booleans
                {
                    scope: ['constant.numeric', 'constant.language.boolean', 'constant.language.json'],
                    settings: { foreground: number },
                },
                // Keywords / storage / operators
                {
                    scope: ['keyword', 'storage', 'storage.type', 'keyword.operator'],
                    settings: { foreground: keyword },
                },
                // Functions / methods / calls
                {
                    scope: ['entity.name.function', 'entity.name.function.method', 'support.function', 'variable.function', 'meta.function-call.generic'],
                    settings: { foreground: func },
                },
                // Types / classes / interfaces
                {
                    scope: ['entity.name.type', 'entity.name.type.class', 'entity.name.type.interface', 'support.type', 'support.class', 'storage.type.class'],
                    settings: { foreground: func },
                },
                // Tags / attributes (JSX/HTML/XML)
                {
                    scope: ['entity.name.tag', 'support.class.component'],
                    settings: { foreground: keyword },
                },
                {
                    scope: ['entity.other.attribute-name', 'meta.attribute'],
                    settings: { foreground: func },
                },
                // Punctuation
                {
                    scope: [
                        'punctuation',
                        'punctuation.terminator',
                        'punctuation.separator',
                        'punctuation.definition.tag',
                        'punctuation.section.block',
                        'punctuation.definition.string',
                    ],
                    settings: { foreground: punctuation },
                },
            ],
        },
        params.id,
    );
}

export const HAPPIER_TEXTMATE_THEME_IDS = Object.freeze({
    light: 'happier-light',
    dark: 'happier-dark',
} as const);

const themeCache = new Map<string, ThemeRegistration>();

export function getHappierTextMateThemeRegistration(params: Readonly<{ isDark: boolean }>): ThemeRegistration {
    const id = params.isDark ? HAPPIER_TEXTMATE_THEME_IDS.dark : HAPPIER_TEXTMATE_THEME_IDS.light;
    const cached = themeCache.get(id);
    if (cached) return cached;

    const theme = params.isDark ? darkTheme : lightTheme;
    const registration = buildHappierTextMateTheme({
        id,
        type: params.isDark ? 'dark' : 'light',
        theme,
    });
    themeCache.set(id, registration);
    return registration;
}
