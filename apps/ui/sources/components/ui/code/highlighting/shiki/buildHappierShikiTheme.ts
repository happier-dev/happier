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
    const surface = colors?.surface as { base?: unknown; inset?: unknown } | undefined;
    const text = colors?.text as { primary?: unknown; secondary?: unknown } | undefined;
    const syntax = colors?.syntax as Record<string, unknown> | undefined;
    const bg = toHex6(surface?.inset ?? surface?.base, params.type === 'dark' ? '#000000' : '#ffffff');
    const fg = toHex6(syntax?.default ?? text?.primary, params.type === 'dark' ? '#ffffff' : '#000000');

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
                settings: { foreground: toHex6(syntax?.comment ?? text?.secondary, fg) },
            },
            {
                scope: ['string', 'punctuation.definition.string', 'string.quoted', 'constant.other.symbol'],
                settings: { foreground: toHex6(syntax?.string, fg) },
            },
            {
                scope: ['constant.numeric', 'constant.language.boolean'],
                settings: { foreground: toHex6(syntax?.number, fg) },
            },
            {
                scope: ['keyword', 'storage', 'storage.type'],
                settings: { foreground: toHex6(syntax?.keyword, fg) },
            },
            {
                scope: ['entity.name.function', 'support.function', 'variable.function'],
                settings: { foreground: toHex6(syntax?.function, fg) },
            },
            {
                scope: ['entity.name.type', 'support.type', 'support.class', 'storage.type.class', 'storage.type.interface'],
                settings: { foreground: toHex6(syntax?.function ?? syntax?.keyword, fg) },
            },
        ],
    };
}
