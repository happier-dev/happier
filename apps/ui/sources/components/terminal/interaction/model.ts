export type TerminalInteractionPolicy = Readonly<{
    osc52Clipboard: 'deny' | 'prompt' | 'allow-session';
    hyperlinks: 'prompt-external' | 'allow-http-https' | 'deny';
    largePasteBytes: number;
    bracketedPaste: 'preserve' | 'force-wrap' | 'disable';
    mouseCapture: 'renderer-capability-gated';
    unsupportedRichProtocols: readonly ('kitty-graphics' | 'sixel' | 'iterm2-images')[];
    sanitizeTitle: true;
    sanitizeBell: true;
}>;

export const DEFAULT_TERMINAL_INTERACTION_POLICY: TerminalInteractionPolicy = {
    osc52Clipboard: 'deny',
    hyperlinks: 'prompt-external',
    largePasteBytes: 32 * 1024,
    bracketedPaste: 'force-wrap',
    mouseCapture: 'renderer-capability-gated',
    unsupportedRichProtocols: ['kitty-graphics', 'sixel', 'iterm2-images'],
    sanitizeTitle: true,
    sanitizeBell: true,
};
