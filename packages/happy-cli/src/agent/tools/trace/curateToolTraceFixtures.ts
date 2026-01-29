import type { ToolTraceEventV1 } from './toolTrace';
import type { ToolTraceFixturesV1 } from './extractToolTraceFixtures';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

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
    const payload: any = event.payload as any;
    if (event.kind === 'tool-call') {
        const name = payload?.name;
        return typeof name === 'string' && name.length > 0 ? name : null;
    }
    if (event.kind === 'permission-request') {
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

function scoreEvent(event: ToolTraceEventV1): number {
    const payload: any = event.payload ?? {};
    let score = 0;

    if (event.kind === 'tool-call') {
        const input = payload.input;
        const inputRec = asRecord(input);
        if (inputRec) {
            const keys = Object.keys(inputRec).filter((k) => k !== '_raw' && k !== '_happy');
            if (keys.length > 0) score += 2;
            if (typeof inputRec.file_path === 'string' || typeof inputRec.filePath === 'string' || typeof inputRec.path === 'string') {
                score += 5;
            }
            if (Array.isArray((inputRec as any).locations) && (inputRec as any).locations.length > 0) score += 2;
        }
    }

    if (event.kind === 'permission-request') {
        const options = payload.options;
        const optRec = asRecord(options);
        if (optRec) {
            const nested = asRecord((optRec as any).toolCall) ?? asRecord((optRec as any)?.options?.toolCall);
            if (nested) {
                score += 4;
                if (Array.isArray((nested as any).locations) && (nested as any).locations.length > 0) score += 2;
                if (Array.isArray((nested as any).content) && (nested as any).content.length > 0) score += 2;
                if (typeof (nested as any).title === 'string' && (nested as any).title.length > 0) score += 1;
            }
        }
    }

    if (event.kind === 'tool-result' || event.kind === 'tool-call-result') {
        const output = payload.output;
        if (typeof output === 'string' && output.trim().length > 0) score += 4;
        const outRec = asRecord(output);
        if (outRec) {
            if (typeof outRec.stdout === 'string' && outRec.stdout.trim().length > 0) score += 3;
            if (typeof (outRec as any).formatted_output === 'string' && (outRec as any).formatted_output.trim().length > 0) score += 2;
            if (typeof (outRec as any).aggregated_output === 'string' && (outRec as any).aggregated_output.trim().length > 0) score += 2;
            if (typeof (outRec as any).error === 'string' && (outRec as any).error.trim().length > 0) score += 1;
        }
    }

    return score;
}

export function curateToolTraceFixturesFromJsonlLines(lines: string[], opts?: {
    maxExamplesPerKey?: number;
    allowlistKeys?: Set<string>;
}): ToolTraceFixturesV1 {
    const maxExamplesPerKey = opts?.maxExamplesPerKey ?? 3;
    const allowlistKeys = opts?.allowlistKeys;

    const buckets: Record<string, Array<{ score: number; event: ToolTraceEventV1 }>> = {};
    const callIdToToolName: Map<string, string> = new Map();
    const recordableEvents: ToolTraceEventV1[] = [];

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

    // First pass: index tool names by callId so tool-result events can be keyed by tool name
    // even if the tool-call arrives later in the stream.
    //
    // Note: Some providers emit permission-request + tool-result without a tool-call (or with a dropped tool-call).
    // In that case, we still want tool-result events to be keyed by tool name for fixture stability.
    for (const fullEvent of recordableEvents) {
        const provider = typeof fullEvent.provider === 'string' && fullEvent.provider.length > 0 ? fullEvent.provider : 'unknown';
        const callId = getCallIdForIndex(fullEvent);
        const sessionId = typeof fullEvent.sessionId === 'string' ? fullEvent.sessionId : 'unknown';
        const callIndexKey =
            callId
                ? `${fullEvent.protocol}/${provider}/${sessionId}/${callId}`
                : null;

        if ((fullEvent.kind === 'tool-call' || fullEvent.kind === 'permission-request') && callIndexKey) {
            const toolName = getToolNameForKey(fullEvent);
            if (toolName) callIdToToolName.set(callIndexKey, toolName);
        }
    }

    // Second pass: bucket recordable events using the completed callId index.
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

        const keyWithToolName = toolName ? `${baseKey}/${toolName}` : baseKey;

        // Back-compat for existing allowlists: allow either the more-specific keyWithToolName or the baseKey.
        const key = (() => {
            if (!allowlistKeys) return keyWithToolName;
            if (allowlistKeys.has(keyWithToolName)) return keyWithToolName;
            if (allowlistKeys.has(baseKey)) return baseKey;
            return null;
        })();
        if (!key) continue;

        const scored = { score: scoreEvent(fullEvent), event: fullEvent };
        (buckets[key] ??= []).push(scored);
    }

    const examples: Record<string, ToolTraceEventV1[]> = {};
    for (const [key, items] of Object.entries(buckets)) {
        items.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (a.event.ts ?? 0) - (b.event.ts ?? 0);
        });
        examples[key] = items.slice(0, maxExamplesPerKey).map((i) => sanitizeEventForFixture(i.event));
    }

    return {
        v: 1,
        generatedAt: Date.now(),
        examples,
    };
}
