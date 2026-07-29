export type TerminalAccessibilityBaseline = 'xterm-screen-reader' | 'native-custom-required';

export function resolveTerminalAccessibilityBaseline(input: Readonly<{
    rendererKind: 'xterm-web' | 'xterm-webview' | 'ghostty-ios' | 'termux-android';
}>): TerminalAccessibilityBaseline {
    return input.rendererKind === 'xterm-web' || input.rendererKind === 'xterm-webview'
        ? 'xterm-screen-reader'
        : 'native-custom-required';
}
