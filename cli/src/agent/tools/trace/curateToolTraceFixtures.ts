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

        const provider = typeof event.provider === 'string' && event.provider.length > 0 ? event.provider : 'unknown';
        const baseKey = `${event.protocol}/${provider}/${event.kind}`;
        const toolName = getToolNameForKey(event as ToolTraceEventV1);
        const key = toolName ? `${baseKey}/${toolName}` : baseKey;
        if (allowlistKeys && !allowlistKeys.has(key)) continue;

        const scored = { score: scoreEvent(event as ToolTraceEventV1), event: event as ToolTraceEventV1 };
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

