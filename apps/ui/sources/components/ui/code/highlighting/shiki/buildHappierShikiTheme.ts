import type { ThemeRegistration } from 'shiki';

type HappierThemeColorsLike = Record<string, unknown>;

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

function normalizeShikiColor(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const raw = value.trim();
    if (!raw) return fallback;
    if (/^#[0-9a-fA-F]{8}$/.test(raw)) return raw.slice(0, 7);
    return raw;
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
    const bg = normalizeShikiColor(surface?.inset ?? surface?.base, params.type === 'dark' ? '#000000' : '#ffffff');
    const fg = normalizeShikiColor(syntax?.default ?? text?.primary, params.type === 'dark' ? '#ffffff' : '#000000');

    return withStableId({
        name: params.id,
        type: params.type,
        colors: {
            'editor.background': bg,
            'editor.foreground': fg,
        },
        tokenColors: [
            {
                scope: ['comment', 'punctuation.definition.comment'],
                settings: { foreground: normalizeShikiColor(syntax?.comment ?? text?.secondary, fg) },
            },
            {
                scope: ['string', 'punctuation.definition.string', 'string.quoted', 'constant.other.symbol'],
                settings: { foreground: normalizeShikiColor(syntax?.string, fg) },
            },
            {
                scope: ['constant.numeric', 'constant.language.boolean'],
                settings: { foreground: normalizeShikiColor(syntax?.number, fg) },
            },
            {
                scope: ['keyword', 'storage', 'storage.type'],
                settings: { foreground: normalizeShikiColor(syntax?.keyword, fg) },
            },
            {
                scope: ['entity.name.function', 'support.function', 'variable.function'],
                settings: { foreground: normalizeShikiColor(syntax?.function, fg) },
            },
            {
                scope: ['entity.name.type', 'support.type', 'support.class', 'storage.type.class', 'storage.type.interface'],
                settings: { foreground: normalizeShikiColor(syntax?.function ?? syntax?.keyword, fg) },
            },
            {
                scope: ['entity.name.tag', 'support.class.component'],
                settings: { foreground: normalizeShikiColor(syntax?.keyword, fg) },
            },
            {
                scope: ['entity.other.attribute-name', 'meta.attribute'],
                settings: { foreground: normalizeShikiColor(syntax?.function, fg) },
            },
            {
                scope: [
                    'punctuation',
                    'punctuation.terminator',
                    'punctuation.separator',
                    'punctuation.definition.tag',
                    'punctuation.section.block',
                ],
                settings: { foreground: normalizeShikiColor(syntax?.comment, fg) },
            },
        ],
    }, params.id);
}
