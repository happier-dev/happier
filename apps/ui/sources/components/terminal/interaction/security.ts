import {
    DEFAULT_TERMINAL_INTERACTION_POLICY,
    type TerminalInteractionPolicy,
} from './model';

export { DEFAULT_TERMINAL_INTERACTION_POLICY };

export type TerminalOsc52ClipboardAction =
    | Readonly<{ kind: 'deny'; reason: 'osc52_denied' }>
    | Readonly<{ kind: 'prompt' }>
    | Readonly<{ kind: 'allow-session' }>;

export function resolveOsc52ClipboardAction(
    policy: TerminalInteractionPolicy = DEFAULT_TERMINAL_INTERACTION_POLICY,
): TerminalOsc52ClipboardAction {
    if (policy.osc52Clipboard === 'prompt') {
        return { kind: 'prompt' };
    }
    if (policy.osc52Clipboard === 'allow-session') {
        return { kind: 'allow-session' };
    }
    return { kind: 'deny', reason: 'osc52_denied' };
}

export type TerminalUnsupportedRichProtocolAction = Readonly<{
    kind: 'unsupported';
    protocol: TerminalInteractionPolicy['unsupportedRichProtocols'][number];
}>;

export function resolveUnsupportedRichProtocolAction(
    protocol: TerminalInteractionPolicy['unsupportedRichProtocols'][number],
    _policy: TerminalInteractionPolicy = DEFAULT_TERMINAL_INTERACTION_POLICY,
): TerminalUnsupportedRichProtocolAction {
    return {
        kind: 'unsupported',
        protocol,
    };
}
