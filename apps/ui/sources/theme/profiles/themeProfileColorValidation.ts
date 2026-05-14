const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_PATTERN = /^rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)$/;
const RGBA_PATTERN = /^rgba\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)$/;

const isByte = (value: string): boolean => {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 255;
};

const isAlpha = (value: string): boolean => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 1;
};

export const isValidThemeProfileColorValue = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;

    const normalized = value.trim();
    if (normalized.length === 0) return false;
    if (normalized === 'transparent') return true;
    if (HEX_COLOR_PATTERN.test(normalized)) return true;

    const rgbMatch = RGB_PATTERN.exec(normalized);
    if (rgbMatch) {
        return rgbMatch.slice(1).every(isByte);
    }

    const rgbaMatch = RGBA_PATTERN.exec(normalized);
    if (rgbaMatch) {
        return rgbaMatch.slice(1, 4).every(isByte) && isAlpha(rgbaMatch[4]);
    }

    return false;
};
