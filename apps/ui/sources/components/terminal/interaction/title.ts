const DEFAULT_TITLE_MAX_CHARS = 120;

function stripTerminalControlCharacters(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

export function sanitizeTerminalTitle(
    value: string,
    maxChars: number = DEFAULT_TITLE_MAX_CHARS,
): string {
    const boundedMax = Math.max(0, Math.trunc(maxChars));
    return stripTerminalControlCharacters(value).slice(0, boundedMax);
}

export function sanitizeTerminalBell(value: string): string {
    return stripTerminalControlCharacters(value).slice(0, DEFAULT_TITLE_MAX_CHARS);
}
