import type { SystemTaskRunState } from '../types';

export type SystemTaskPromptEnvelope = Readonly<{
    kind: string;
    message: string;
    data: Record<string, unknown>;
}>;

export function readLatestSystemTaskPrompt(snapshot: SystemTaskRunState | null): SystemTaskPromptEnvelope | null {
    if (!snapshot) {
        return null;
    }

    const promptEvent = [...snapshot.events].reverse().find((event) => event.type === 'prompt');
    if (!promptEvent) {
        return null;
    }

    const dataRaw = promptEvent.data;
    if (!dataRaw || typeof dataRaw !== 'object' || Array.isArray(dataRaw)) {
        return null;
    }

    const record = dataRaw as Record<string, unknown>;
    const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
    if (!kind) {
        return null;
    }

    return {
        kind,
        message: promptEvent.message ?? snapshot.latestMessage ?? '',
        data: record,
    };
}
