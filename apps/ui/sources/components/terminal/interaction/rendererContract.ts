import { resolveTerminalAccessibilityBaseline } from './accessibility';
import { resolveTerminalImeInput, type TerminalImeEvent } from './ime';
import { shouldTerminalCaptureKeyboardEvent, type TerminalKeyboardModifiers } from './keyboard';
import { shouldTerminalCaptureMouse } from './mouse';
import { readTerminalSelectionSnapshot } from './selection';
import {
    resolveOsc52ClipboardAction,
    resolveUnsupportedRichProtocolAction,
} from './security';
import {
    DEFAULT_TERMINAL_INTERACTION_POLICY,
    type TerminalInteractionPolicy,
} from './model';

export type TerminalRendererKind = 'xterm-web' | 'xterm-webview' | 'ghostty-ios' | 'termux-android';

export type TerminalRendererInteractionContract = Readonly<{
    rendererKind: TerminalRendererKind;
    screenReaderMode: boolean;
    mouseCaptureEnabled: boolean;
    hostCopyShortcuts: boolean;
    committedImeOnly: boolean;
    osc52Clipboard: 'deny' | 'prompt' | 'allow-session';
    unsupportedRichProtocols: readonly ('kitty-graphics' | 'sixel' | 'iterm2-images')[];
}>;

export function buildTerminalRendererInteractionContract(
    rendererKind: TerminalRendererKind,
    policy: TerminalInteractionPolicy = DEFAULT_TERMINAL_INTERACTION_POLICY,
): TerminalRendererInteractionContract {
    const accessibility = resolveTerminalAccessibilityBaseline({ rendererKind });
    return {
        rendererKind,
        screenReaderMode: accessibility === 'xterm-screen-reader',
        mouseCaptureEnabled: shouldTerminalCaptureMouse({
            capability: { supportsMouseCapture: true },
            terminalFocused: true,
        }),
        hostCopyShortcuts: !shouldRendererCaptureKeyboard({ key: 'c', modifiers: ['ctrl'] }),
        committedImeOnly: resolveRendererCommittedInput('probe') === 'probe',
        osc52Clipboard: resolveOsc52ClipboardAction(policy).kind,
        unsupportedRichProtocols: policy.unsupportedRichProtocols.filter((protocol) => (
            resolveUnsupportedRichProtocolAction(protocol, policy).kind === 'unsupported'
        )),
    };
}

export function shouldRendererCaptureKeyboard(input: Readonly<{
    key: string;
    modifiers: TerminalKeyboardModifiers;
}>): boolean {
    return shouldTerminalCaptureKeyboardEvent({
        terminalFocused: true,
        key: input.key,
        modifiers: input.modifiers,
    });
}

export function resolveRendererCommittedInput(text: string): string {
    const event: TerminalImeEvent = { phase: 'commit', text };
    return resolveTerminalImeInput(event);
}

export function readRendererSelection(input: Readonly<{
    hasSelection?: () => boolean;
    getSelectionText?: () => string;
}>): Readonly<{ hasSelection: boolean; text: string }> {
    return readTerminalSelectionSnapshot(input);
}

export function shouldConsumeTerminalControlSequence(
    contract: TerminalRendererInteractionContract,
    kind: 'osc52' | 'kitty-graphics' | 'sixel' | 'iterm2-images',
): boolean {
    if (kind === 'osc52') {
        return contract.osc52Clipboard !== 'allow-session';
    }
    return contract.unsupportedRichProtocols.includes(kind);
}
