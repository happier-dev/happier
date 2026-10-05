export type TerminalKeyboardModifiers = readonly ('shift' | 'ctrl' | 'alt' | 'meta')[];

export type TerminalKeyboardEvent = Readonly<{
    key: string;
    modifiers: TerminalKeyboardModifiers;
}>;

export function shouldTerminalCaptureKeyboardEvent(input: Readonly<{
    terminalFocused: boolean;
    key: string;
    modifiers: TerminalKeyboardModifiers;
    /** The canonical keyboard provider already admitted and handled this event. */
    defaultPrevented?: boolean;
}>): boolean {
    if (!input.terminalFocused || input.defaultPrevented) {
        return false;
    }
    const normalizedKey = input.key.toLowerCase();
    const isGlobalCopy = normalizedKey === 'c' && (input.modifiers.includes('ctrl') || input.modifiers.includes('meta'));
    return !isGlobalCopy;
}
