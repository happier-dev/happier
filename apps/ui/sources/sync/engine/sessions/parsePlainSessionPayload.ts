import { AgentStateSchema, MetadataSchema, type AgentState, type Metadata } from '@/sync/domains/state/storageTypes';

export function tryParsePlainSessionMetadata(value: string): Metadata | undefined {
    try {
        const parsedJson = JSON.parse(value);
        const parsed = MetadataSchema.safeParse(parsedJson);
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

export function parsePlainSessionMetadata(value: string): Metadata | null {
    return tryParsePlainSessionMetadata(value) ?? null;
}

export function tryParsePlainSessionAgentState(value: string | null): AgentState | undefined {
    if (!value) return {};
    try {
        const parsedJson = JSON.parse(value);
        const parsed = AgentStateSchema.safeParse(parsedJson);
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

export function parsePlainSessionAgentState(value: string | null): AgentState {
    return tryParsePlainSessionAgentState(value) ?? {};
}
