import type { SystemTaskJsonObject } from '@happier-dev/protocol/system/tasks/spec';

import type { SystemTaskPromptEnvelope, SystemTaskRunState } from '../types';

export type { SystemTaskPromptEnvelope };

export function getSystemTaskPromptSignature(prompt: SystemTaskPromptEnvelope): string {
    return `${prompt.kind}:${JSON.stringify(prompt.data)}`;
}

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
