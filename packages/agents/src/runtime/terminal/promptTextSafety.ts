export type TerminalPromptTextSafetyResult =
    | Readonly<{ ok: true; text: string; multiline: boolean }>
    | Readonly<{ ok: false; reason: 'terminal_control_byte' }>;

function normalizeTerminalPromptLineEndings(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

function isUnsafePromptControlCode(codePoint: number): boolean {
    if (codePoint === 0x09 || codePoint === 0x0a) return false;
    if (codePoint < 0x20) return true;
    if (codePoint === 0x7f) return true;
    return codePoint >= 0x80 && codePoint <= 0x9f;
}

export function prepareTerminalPromptTextForInjection(text: string): TerminalPromptTextSafetyResult {
    const normalizedText = normalizeTerminalPromptLineEndings(text);
    for (const character of normalizedText) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && isUnsafePromptControlCode(codePoint)) {
            return { ok: false, reason: 'terminal_control_byte' };
        }
    }
    return {
        ok: true,
        text: normalizedText,
        multiline: normalizedText.includes('\n'),
    };
}
