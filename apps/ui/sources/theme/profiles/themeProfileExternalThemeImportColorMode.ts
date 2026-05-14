import type { ThemeProfileMode } from './themeProfileTypes';

const isString = (value: unknown): value is string => typeof value === 'string';

const normalizeThemeMode = (value: unknown): ThemeProfileMode | null => {
    if (!isString(value)) return null;
    const normalized = value.trim().toLowerCase();
    if (normalized.includes('light')) return 'light';
    if (normalized.includes('dark')) return 'dark';
    return null;
};

const parseColorChannel = (value: string): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 255) return null;
    return Math.round(parsed);
};

const parseThemeColor = (value: string): Readonly<{ red: number; green: number; blue: number }> | null => {
    const normalized = value.trim();
    if (/^#([0-9a-fA-F]{3,8})$/.test(normalized)) {
        const hex = normalized.slice(1);
        const expanded = hex.length === 3 || hex.length === 4
            ? hex.split('').map((character) => `${character}${character}`).join('')
            : hex;
        if (expanded.length < 6) return null;
        const red = Number.parseInt(expanded.slice(0, 2), 16);
        const green = Number.parseInt(expanded.slice(2, 4), 16);
        const blue = Number.parseInt(expanded.slice(4, 6), 16);
        if ([red, green, blue].some((channel) => Number.isNaN(channel))) return null;
        return { red, green, blue };
    }

    const rgbMatch = /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/.exec(normalized);
    if (!rgbMatch) return null;

    const red = parseColorChannel(rgbMatch[1]);
    const green = parseColorChannel(rgbMatch[2]);
    const blue = parseColorChannel(rgbMatch[3]);
    if (red === null || green === null || blue === null) return null;

    return { red, green, blue };
};

const getColorLuminance = (value: string): number | null => {
    const color = parseThemeColor(value);
    if (!color) return null;

    const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });

    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
};

const inferThemeModeFromColor = (value: string): ThemeProfileMode | null => {
    const luminance = getColorLuminance(value);
    if (luminance === null) return null;
    return luminance >= 0.5 ? 'light' : 'dark';
};

const pickColorValue = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
    for (const key of keys) {
        const value = record[key];
        if (isString(value) && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
};

export const pickThemeMode = (theme: Record<string, unknown>): ThemeProfileMode => {
    const explicitMode = normalizeThemeMode(theme.type);
    if (explicitMode) return explicitMode;

    const candidateColors = [
        theme.colors,
        theme.workbenchColorCustomizations,
    ].filter((value): value is Record<string, unknown> => (
        typeof value === 'object' && value !== null && !Array.isArray(value)
    ));

    for (const colors of candidateColors) {
        const inferred = inferThemeModeFromColor(pickColorValue(colors, [
            'editor.background',
            'sideBar.background',
            'activityBar.background',
            'panel.background',
            'titleBar.activeBackground',
        ]) ?? '');
        if (inferred) return inferred;
    }

    return 'dark';
};
