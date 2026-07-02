export const WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT = 50_000;
export const TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT = 200_000;
export const TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS = 500;

export function isLargeTextInputValueLength(length: number): boolean {
    return Number.isFinite(length) && length > TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT;
}

export function containsLikelyNonWhitespace(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12 && code !== 11 && code !== 160) {
            return true;
        }
    }
    return false;
}
