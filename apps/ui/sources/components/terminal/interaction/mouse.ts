export type TerminalMouseCapability = Readonly<{
    supportsMouseCapture: boolean;
}>;

export function shouldTerminalCaptureMouse(input: Readonly<{
    capability: TerminalMouseCapability;
    terminalFocused: boolean;
}>): boolean {
    return input.terminalFocused && input.capability.supportsMouseCapture;
}
