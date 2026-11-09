import { ToolNormalizationProtocolSchema, ToolNormalizationSourceV3Schema, type ToolNormalizationProtocol, type ToolNormalizationSourceV3 } from '@happier-dev/protocol/tools/v2/meta';

export type ToolTraceProtocol = ToolNormalizationProtocol;

export type ToolTraceDirection = 'outbound' | 'inbound';

export type ToolTraceEventV1 = {
    v: 1;
    ts: number;
    direction: ToolTraceDirection;
    sessionId: string;
    protocol: ToolTraceProtocol;
    provider?: string;
    kind: string;
    payload: unknown;
    localId?: string;
};

export type ToolTraceEventV2 = Omit<ToolTraceEventV1, 'v' | 'protocol' | 'provider'> & {
    v: 2;
    source: ToolNormalizationSourceV3;
};

export type ToolTraceEvent = ToolTraceEventV1 | ToolTraceEventV2;

/** V1 is frozen predecessor JSONL ingress; current writers emit V2. */
export function readToolTraceEvent(value: unknown): ToolTraceEvent | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const event = value as Record<string, unknown>;
    if (typeof event.kind !== 'string') return null;
    if (event.v === 1) {
        if (!ToolNormalizationProtocolSchema.safeParse(event.protocol).success) return null;
        return event as ToolTraceEventV1;
    }
    if (event.v === 2) {
        const source = ToolNormalizationSourceV3Schema.safeParse(event.source);
        if (!source.success) return null;
        return { ...event, source: source.data } as ToolTraceEventV2;
    }
    return null;
}

export function getToolTraceSourceKey(event: ToolTraceEvent): string {
    if (event.v === 2) return `${event.source.protocol}/${event.source.agent.pluginId}/${event.source.agent.localId}`;
    const provider = typeof event.provider === 'string' && event.provider.length > 0 ? event.provider : 'unknown';
    return `${event.protocol}/${provider}`;
}
