import { getToolTraceSourceKey, type ToolTraceEvent } from './toolTraceEvent';
import { getCallIdForIndex, readToolTraceFixtureEvents, sanitizeEventForFixture, type ToolTraceFixturesV2 } from './extractToolTraceFixtures';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function scoreEvent(event: ToolTraceEvent): number {
    const payload: any = event.payload ?? {};
    let score = 0;

    if (event.kind === 'tool-call') {
        const input = payload.input;
        const inputRec = asRecord(input);
        if (inputRec) {
            const keys = Object.keys(inputRec).filter((k) => k !== '_raw' && k !== '_happier');
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
}): ToolTraceFixturesV2 {
    const maxExamplesPerKey = opts?.maxExamplesPerKey ?? 3;
    const allowlistKeys = opts?.allowlistKeys;

    const buckets: Record<string, Array<{ score: number; event: ToolTraceEvent }>> = {};
    const callIdToToolName: Map<string, string> = new Map();
    const recordableEvents = readToolTraceFixtureEvents(lines);

    // First pass: index tool names by callId so tool-result events can be keyed by tool name
    // even if the tool-call arrives later in the stream.
    //
    // Note: Some providers emit permission-request + tool-result without a tool-call (or with a dropped tool-call).
    // In that case, we still want tool-result events to be keyed by tool name for fixture stability.
    for (const { event: fullEvent, toolName } of recordableEvents) {
        const sourceKey = getToolTraceSourceKey(fullEvent);
        const callId = getCallIdForIndex(fullEvent);
        const sessionId = typeof fullEvent.sessionId === 'string' ? fullEvent.sessionId : 'unknown';
        const callIndexKey =
            callId
                ? `${sourceKey}/${sessionId}/${callId}`
                : null;

        if ((fullEvent.kind === 'tool-call' || fullEvent.kind === 'permission-request') && callIndexKey) {
            if (toolName) callIdToToolName.set(callIndexKey, toolName);
        }
    }

    // Second pass: bucket recordable events using the completed callId index.
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

    const examples: Record<string, ToolTraceEvent[]> = {};
    for (const [key, items] of Object.entries(buckets)) {
        items.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (a.event.ts ?? 0) - (b.event.ts ?? 0);
        });
        examples[key] = items.slice(0, maxExamplesPerKey).map((i) => sanitizeEventForFixture(i.event));
    }

    return {
        v: 2,
        generatedAt: Date.now(),
        examples,
    };
}
