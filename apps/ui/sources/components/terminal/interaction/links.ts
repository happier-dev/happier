import {
    DEFAULT_TERMINAL_INTERACTION_POLICY,
    type TerminalInteractionPolicy,
} from './model';

export { DEFAULT_TERMINAL_INTERACTION_POLICY };

export type TerminalHyperlinkAction =
    | Readonly<{ kind: 'deny'; reason: 'invalid_url' | 'unsupported_scheme' | 'policy_denied' }>
    | Readonly<{ kind: 'prompt'; url: string }>
    | Readonly<{ kind: 'allow'; url: string }>;

export function resolveTerminalHyperlinkAction(
    rawUrl: string,
    policy: TerminalInteractionPolicy = DEFAULT_TERMINAL_INTERACTION_POLICY,
): TerminalHyperlinkAction {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { kind: 'deny', reason: 'invalid_url' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { kind: 'deny', reason: 'unsupported_scheme' };
    }

    if (policy.hyperlinks === 'deny') {
        return { kind: 'deny', reason: 'policy_denied' };
    }
    if (policy.hyperlinks === 'allow-http-https') {
        return { kind: 'allow', url: parsed.toString() };
    }
    return { kind: 'prompt', url: parsed.toString() };
}
