import { parseThemeColorValue } from './themeColor.js';

/** Opaque appearance choices share the theme editor's hex admission owner. */
export function normalizeOpaqueThemeHexColor(value: unknown): `#${string}` | null {
    if (typeof value !== 'string') return null;
    const hex = value.trim();
    if (!hex.startsWith('#') || (hex.length !== 4 && hex.length !== 7) || !parseThemeColorValue(hex)) return null;
    const digits = hex.slice(1);
    return `#${(digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits).toUpperCase()}`;
}
export const isValidThemeProfileColorValue = (value: unknown): value is string => {
    return typeof value === 'string' && parseThemeColorValue(value) !== null;
};
