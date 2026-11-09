import { resolveToolEnvelopeMeta } from '@happier-dev/protocol/tools/v2/meta';
import { getToolTraceSourceKey, readToolTraceEvent, type ToolTraceEvent, type ToolTraceEventV1 } from './toolTraceEvent';

export type ToolTraceFixturesV1 = {
    v: 1;
    generatedAt: number;
    examples: Record<string, ToolTraceEventV1[]>;
};

export type ToolTraceFixturesV2 = {
    v: 2;
    generatedAt: number;
    examples: Record<string, ToolTraceEvent[]>;
};

export function readToolTraceFixtures(value: unknown): ToolTraceFixturesV1 | ToolTraceFixturesV2 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const fixture = value as Record<string, unknown>;
    if ((fixture.v !== 1 && fixture.v !== 2) || typeof fixture.generatedAt !== 'number') return null;
    if (!fixture.examples || typeof fixture.examples !== 'object' || Array.isArray(fixture.examples)) return null;
    const examples: Record<string, ToolTraceEvent[]> = {};
    for (const [key, values] of Object.entries(fixture.examples)) {
        if (!Array.isArray(values)) return null;
        const events: ToolTraceEvent[] = [];
        for (const value of values) {
            const event = readToolTraceEvent(value);
            if (!event || (fixture.v === 1 && event.v !== 1)) return null;
            events.push(event);
        }
        examples[key] = events;
    }
    return { v: fixture.v, generatedAt: fixture.generatedAt, examples } as ToolTraceFixturesV1 | ToolTraceFixturesV2;
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

function getToolNameForKey(event: ToolTraceEvent): string | null {
    if (event.kind === 'tool-call') {
        const payload = event.payload as any;
        const canonical = resolveToolEnvelopeMeta(payload?.input)?.canonicalToolName;
        if (typeof canonical === 'string' && canonical.length > 0) return canonical;
        const name = payload?.name;
        return typeof name === 'string' && name.length > 0 ? name : null;
    }
    if (event.kind === 'tool-result' || event.kind === 'tool-call-result') {
        const payload = event.payload as any;
        const canonical = resolveToolEnvelopeMeta(payload?.output)?.canonicalToolName;
        if (typeof canonical === 'string' && canonical.length > 0) return canonical;
        const name = payload?.name ?? payload?.toolName;
        return typeof name === 'string' && name.length > 0 ? name : null;
    }
    if (event.kind === 'permission-request') {
        const payload = event.payload as any;
        const toolName = payload?.toolName;
        return typeof toolName === 'string' && toolName.length > 0 ? toolName : null;
    }
    return null;
}

export function getCallIdForIndex(event: ToolTraceEvent): string | null {
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

export function sanitizeEventForFixture(event: ToolTraceEvent): ToolTraceEvent {
    return {
        ...event,
        payload: truncateDeep(event.payload),
    };
}

export function readToolTraceFixtureEvents(lines: readonly string[]): Array<{ event: ToolTraceEvent; toolName: string | null }> {
    const events: Array<{ event: ToolTraceEvent; toolName: string | null }> = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            continue;
        }

        const event = readToolTraceEvent(parsed);
        if (!event) continue;
        if (!isRecordableKind(event.kind)) continue;

        events.push({ event, toolName: getToolNameForKey(event) });
    }
    return events;
}

export function extractToolTraceFixturesFromJsonlLines(lines: string[]): ToolTraceFixturesV2 {
    const examples: Record<string, ToolTraceEvent[]> = {};
    const recordableEvents = readToolTraceFixtureEvents(lines);
    const callIdToToolName: Map<string, string> = new Map();

    // First pass: index tool names by callId so tool-result events can be keyed by tool name even if
    // the tool-call is missing/dropped (permission-request + tool-result) or arrives later.
    for (const { event: fullEvent, toolName } of recordableEvents) {
        const sourceKey = getToolTraceSourceKey(fullEvent);
        const callId = getCallIdForIndex(fullEvent);
        const sessionId = typeof fullEvent.sessionId === 'string' ? fullEvent.sessionId : 'unknown';
        const callIndexKey =
            callId
                ? `${sourceKey}/${sessionId}/${callId}`
                : null;
        if (!callIndexKey) continue;
        if (fullEvent.kind !== 'tool-call' && fullEvent.kind !== 'permission-request') continue;

        if (toolName) callIdToToolName.set(callIndexKey, toolName);
    }

    // Second pass: bucket events.
    for (const { event: fullEvent, toolName: toolNameFromEvent } of recordableEvents) {
        const sourceKey = getToolTraceSourceKey(fullEvent);
        const baseKey = `${sourceKey}/${fullEvent.kind}`;

        const callId = getCallIdForIndex(fullEvent);
        const sessionId = typeof fullEvent.sessionId === 'string' ? fullEvent.sessionId : 'unknown';
        const callIndexKey =
            callId
                ? `${sourceKey}/${sessionId}/${callId}`
                : null;

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
        v: 2,
        generatedAt: Date.now(),
        examples,
    };
}
