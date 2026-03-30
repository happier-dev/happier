import { AgentStateSchema, MetadataSchema, type AgentState, type Metadata } from '@/sync/domains/state/storageTypes';

export function parsePlainSessionMetadata(value: string): Metadata | null {
    try {
        const parsedJson = JSON.parse(value);
        const parsed = MetadataSchema.safeParse(parsedJson);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function parsePlainSessionAgentState(value: string | null): AgentState {
    if (!value) return {};
    try {
        const parsedJson = JSON.parse(value);
        const parsed = AgentStateSchema.safeParse(parsedJson);
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}
