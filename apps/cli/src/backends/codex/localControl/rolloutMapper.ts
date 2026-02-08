import {
    canonicalizeCodexRolloutToolName,
    normalizeCodexRolloutToolInput,
} from './rolloutToolNameMapping';

export type CodexRolloutAction =
    | { type: 'codex-session-id'; id: string }
    | { type: 'user-text'; text: string }
    | { type: 'assistant-text'; text: string }
    | { type: 'tool-call'; callId: string; name: string; input: unknown }
    | { type: 'tool-result'; callId: string; output: unknown }
    | { type: 'debug'; message: string; value?: unknown };

type RolloutEnvelope = { timestamp?: string; type?: string; payload?: any };

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function coerceTextFromMessageContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const item of content) {
        const rec = asRecord(item);
        if (!rec) continue;
        const text = typeof rec.text === 'string' ? rec.text : null;
        if (text && text.trim().length > 0) parts.push(text);
    }
    return parts.join('\n');
}

function shouldFilterHarnessBlob(text: string): boolean {
    const t = text.trim();
    if (!t) return true;
    // Known harness/system blobs embedded as user content.
    const patterns = [
        '# AGENTS.md instructions',
        '<environment_context>',
        '<turn_aborted>',
        '<INSTRUCTIONS>',
        'You are GPT-',
        'Codex CLI is an open source project',
    ];
    return patterns.some((p) => t.includes(p));
}

function safeJsonParse(value: string): unknown | null {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function withLocalControlMeta(input: unknown): unknown {
    const record = asRecord(input);
    if (record) {
        const currentHappier = asRecord((record as any)._happier) ?? {};
        const legacyHappy = asRecord((record as any)._happy) ?? {};
        return {
            ...record,
            _happier: { ...legacyHappy, ...currentHappier, sessionMode: 'local_control' },
        };
    }
    return { _raw: input, _happier: { sessionMode: 'local_control' } };
}

export function mapCodexRolloutEventToActions(event: unknown, opts: { debug: boolean }): CodexRolloutAction[] {
    const env = asRecord(event) as RolloutEnvelope | null;
    if (!env || typeof env.type !== 'string') return [];

    if (env.type === 'session_meta') {
        const payload = asRecord(env.payload);
        const id = payload && typeof payload.id === 'string' ? payload.id : null;
        if (!id) return [];
        return [{ type: 'codex-session-id', id }];
    }

    if (env.type !== 'response_item') return [];
    const payload = asRecord(env.payload) ?? {};
    const payloadType = typeof (payload as any).type === 'string' ? String((payload as any).type) : '';

    if (payloadType === 'message') {
        const role = typeof (payload as any).role === 'string' ? String((payload as any).role) : '';
        const content = coerceTextFromMessageContent((payload as any).content);
        if (!content.trim()) return [];

        if (role === 'developer') {
            return opts.debug ? [{ type: 'debug', message: 'developer message', value: payload }] : [];
        }

        if (role === 'user') {
            if (!opts.debug && shouldFilterHarnessBlob(content)) return [];
            return [{ type: 'user-text', text: content }];
        }

        // Default: assistant/agent output.
        return [{ type: 'assistant-text', text: content }];
    }

    if (payloadType === 'function_call') {
        const name = typeof (payload as any).name === 'string' ? String((payload as any).name) : '';
        const callId = typeof (payload as any).call_id === 'string' ? String((payload as any).call_id) : '';
        if (!name || !callId) return [];

        const { canonicalToolName, visibility } = canonicalizeCodexRolloutToolName(name);
        if (visibility === 'ignore') return [];
        if (visibility === 'debug-only' && !opts.debug) return [];

        const rawArgs = (payload as any).arguments;
        const parsedArgs =
            typeof rawArgs === 'string'
                ? safeJsonParse(rawArgs) ?? rawArgs
                : rawArgs;
        const input = withLocalControlMeta(normalizeCodexRolloutToolInput(name, parsedArgs));

        return [{ type: 'tool-call', callId, name: canonicalToolName, input }];
    }

    if (payloadType === 'function_call_output') {
        const callId = typeof (payload as any).call_id === 'string' ? String((payload as any).call_id) : '';
        if (!callId) return [];
        const outputRaw = (payload as any).output;
        const output = typeof outputRaw === 'string' ? safeJsonParse(outputRaw) ?? outputRaw : outputRaw;
        return [{ type: 'tool-result', callId, output }];
    }

    if (payloadType === 'custom_tool_call') {
        const name = typeof (payload as any).name === 'string' ? String((payload as any).name) : '';
        const callId = typeof (payload as any).call_id === 'string' ? String((payload as any).call_id) : '';
        if (!name || !callId) return [];

        const { canonicalToolName, visibility } = canonicalizeCodexRolloutToolName(name);
        if (visibility === 'ignore') return [];
        if (visibility === 'debug-only' && !opts.debug) return [];

        const input = withLocalControlMeta(normalizeCodexRolloutToolInput(name, (payload as any).input));
        return [{ type: 'tool-call', callId, name: canonicalToolName, input }];
    }

    if (payloadType === 'custom_tool_call_output') {
        const callId = typeof (payload as any).call_id === 'string' ? String((payload as any).call_id) : '';
        if (!callId) return [];
        const outputRaw = (payload as any).output;
        const output = typeof outputRaw === 'string' ? safeJsonParse(outputRaw) ?? outputRaw : outputRaw;
        return [{ type: 'tool-result', callId, output }];
    }

    return opts.debug ? [{ type: 'debug', message: `unhandled rollout payload type: ${payloadType}`, value: payload }] : [];
}
