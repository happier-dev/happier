import type { ThemeRegistration } from 'shiki';

type HappierThemeColorsLike = Record<string, unknown>;

function toHex6(value: unknown, fallback: string): string {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
    if (/^#[0-9a-fA-F]{8}$/.test(raw)) return raw.slice(0, 7);
    return fallback;
}

export function buildHappierShikiTheme(params: Readonly<{
    id: string;
    type: 'light' | 'dark';
    colors: HappierThemeColorsLike;
}>): ThemeRegistration {
    const colors: any = params.colors as any;
    const bg = toHex6(colors?.surfaceHigh ?? colors?.surface, params.type === 'dark' ? '#000000' : '#ffffff');
    const fg = toHex6(colors?.syntaxDefault ?? colors?.text, params.type === 'dark' ? '#ffffff' : '#000000');

    return {
        name: params.id,
        type: params.type,
        colors: {
            'editor.background': bg,
            'editor.foreground': fg,
        },
        tokenColors: [
            {
                scope: ['comment', 'punctuation.definition.comment'],
                settings: { foreground: toHex6(colors?.syntaxComment ?? colors?.textSecondary, fg) },
            },
            {
                scope: ['string', 'punctuation.definition.string', 'string.quoted', 'constant.other.symbol'],
                settings: { foreground: toHex6(colors?.syntaxString, fg) },
            },
            {
                scope: ['constant.numeric', 'constant.language.boolean'],
                settings: { foreground: toHex6(colors?.syntaxNumber, fg) },
            },
            {
                scope: ['keyword', 'storage', 'storage.type'],
                settings: { foreground: toHex6(colors?.syntaxKeyword, fg) },
            },
            {
                scope: ['entity.name.function', 'support.function', 'variable.function'],
                settings: { foreground: toHex6(colors?.syntaxFunction, fg) },
            },
            {
                scope: ['entity.name.type', 'support.type', 'support.class', 'storage.type.class', 'storage.type.interface'],
                settings: { foreground: toHex6(colors?.syntaxFunction ?? colors?.syntaxKeyword, fg) },
            },
        ],
    };
}
