import type { SystemTaskJsonObject } from '@happier-dev/protocol';

import type { SystemTaskRunState } from '../types';

export type SystemTaskPromptEnvelope = Readonly<{
    kind: string;
    message: string;
    data: SystemTaskJsonObject;
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

    const record = dataRaw as SystemTaskJsonObject;
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
