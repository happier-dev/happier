import type { ToolTraceEventV1 } from './toolTrace';

export type ToolTraceFixturesV1 = {
    v: 1;
    generatedAt: number;
    examples: Record<string, ToolTraceEventV1[]>;
};

function isRecordableKind(kind: string): boolean {
    return (
        kind === 'tool-call' ||
        kind === 'tool-result' ||
        kind === 'tool-call-result' ||
        kind === 'permission-request' ||
        kind === 'file-edit' ||
        kind === 'terminal-output'
    );
}

function getToolNameForKey(event: ToolTraceEventV1): string | null {
    if (event.kind === 'tool-call') {
        const payload = event.payload as any;
        const name = payload?.name;
        return typeof name === 'string' && name.length > 0 ? name : null;
    }
    if (event.kind === 'permission-request') {
        const payload = event.payload as any;
        const toolName = payload?.toolName;
        return typeof toolName === 'string' && toolName.length > 0 ? toolName : null;
    }
    return null;
}

function getCallIdForIndex(event: ToolTraceEventV1): string | null {
    const payload: any = event.payload as any;
    if (event.kind === 'tool-call') {
        const callId = payload?.callId ?? payload?.id ?? payload?.toolCallId;
        return typeof callId === 'string' && callId.length > 0 ? callId : null;
    }
    if (event.kind === 'tool-result' || event.kind === 'tool-call-result') {
        const callId = payload?.callId ?? payload?.tool_use_id ?? payload?.toolUseId ?? payload?.tool_useId;
        return typeof callId === 'string' && callId.length > 0 ? callId : null;
    }
    if (event.kind === 'permission-request') {
        const callId = payload?.permissionId ?? payload?.toolCallId;
        return typeof callId === 'string' && callId.length > 0 ? callId : null;
    }
    return null;
}

function truncateDeep(value: unknown, opts?: { maxString?: number; maxArray?: number; maxObjectKeys?: number }): unknown {
    const maxString = opts?.maxString ?? 2_000;
    const maxArray = opts?.maxArray ?? 50;
    const maxObjectKeys = opts?.maxObjectKeys ?? 200;

    if (typeof value === 'string') {
        if (value.length <= maxString) return value;
        return `${value.slice(0, maxString)}…(truncated ${value.length - maxString} chars)`;
    }

    if (typeof value !== 'object' || value === null) return value;

    if (Array.isArray(value)) {
        const sliced = value.slice(0, maxArray).map((v) => truncateDeep(v, opts));
        if (value.length <= maxArray) return sliced;
        return [...sliced, `…(truncated ${value.length - maxArray} items)`];
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const sliced = entries.slice(0, maxObjectKeys);
    const out: Record<string, unknown> = {};
    for (const [k, v] of sliced) out[k] = truncateDeep(v, opts);
    if (entries.length > maxObjectKeys) out._truncatedKeys = entries.length - maxObjectKeys;
    return out;
}

function sanitizeEventForFixture(event: ToolTraceEventV1): ToolTraceEventV1 {
    return {
        ...event,
        payload: truncateDeep(event.payload),
    };
}

export function extractToolTraceFixturesFromJsonlLines(lines: string[]): ToolTraceFixturesV1 {
    const examples: Record<string, ToolTraceEventV1[]> = {};
    const recordableEvents: ToolTraceEventV1[] = [];
    const callIdToToolName: Map<string, string> = new Map();

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            continue;
        }

        const event = parsed as Partial<ToolTraceEventV1>;
        if (event?.v !== 1) continue;
        if (typeof event.kind !== 'string' || typeof event.protocol !== 'string') continue;
        if (!isRecordableKind(event.kind)) continue;

        recordableEvents.push(event as ToolTraceEventV1);
    }

    // First pass: index tool names by callId so tool-result events can be keyed by tool name even if
    // the tool-call is missing/dropped (permission-request + tool-result) or arrives later.
    for (const fullEvent of recordableEvents) {
        const provider = typeof fullEvent.provider === 'string' && fullEvent.provider.length > 0 ? fullEvent.provider : 'unknown';
        const callId = getCallIdForIndex(fullEvent);
        const sessionId = typeof fullEvent.sessionId === 'string' ? fullEvent.sessionId : 'unknown';
        const callIndexKey =
            callId
                ? `${fullEvent.protocol}/${provider}/${sessionId}/${callId}`
                : null;
        if (!callIndexKey) continue;
        if (fullEvent.kind !== 'tool-call' && fullEvent.kind !== 'permission-request') continue;

        const toolName = getToolNameForKey(fullEvent);
        if (toolName) callIdToToolName.set(callIndexKey, toolName);
    }

    // Second pass: bucket events.
    for (const fullEvent of recordableEvents) {
        const provider = typeof fullEvent.provider === 'string' && fullEvent.provider.length > 0 ? fullEvent.provider : 'unknown';
        const baseKey = `${fullEvent.protocol}/${provider}/${fullEvent.kind}`;

        const callId = getCallIdForIndex(fullEvent);
        const sessionId = typeof fullEvent.sessionId === 'string' ? fullEvent.sessionId : 'unknown';
        const callIndexKey =
            callId
                ? `${fullEvent.protocol}/${provider}/${sessionId}/${callId}`
                : null;

        const toolNameFromEvent = getToolNameForKey(fullEvent);
        const toolNameFromCallId =
            (fullEvent.kind === 'tool-result' || fullEvent.kind === 'tool-call-result') && callIndexKey
                ? (callIdToToolName.get(callIndexKey) ?? null)
                : null;
        const toolName = toolNameFromEvent ?? toolNameFromCallId;
        const key = toolName ? `${baseKey}/${toolName}` : baseKey;

        const current = examples[key] ?? [];
        if (current.length >= 3) continue;
        current.push(sanitizeEventForFixture(fullEvent));
        examples[key] = current;
    }

    return {
        v: 1,
        generatedAt: Date.now(),
        examples,
    };
}
