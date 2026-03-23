import type { LocalVoiceAgentToolResultEntry } from '@/voice/local/runVoiceAgentTurnWithTools';

import { normalizeVoiceQaText } from './voiceQaSessionResolution';

const LOCAL_QA_ASYNC_TARGET_FOLLOW_UP_TOOL_NAMES = new Set(['sendSessionMessage']);

function formatToolResultStatus(entry: LocalVoiceAgentToolResultEntry): string {
    const toolName = normalizeVoiceQaText(entry?.t) || 'unknown';
    const result = entry?.result;
    if (result && typeof result === 'object') {
        const record = result as Record<string, unknown>;
        const errorCode = normalizeVoiceQaText(record.errorCode);
        if (errorCode) return `${toolName}(error:${errorCode})`;
        if (record.ok === true) return `${toolName}(ok)`;
        if (record.ok === false) return `${toolName}(error)`;
    }
    return `${toolName}(ok)`;
}

export function formatVoiceQaToolResultsSummary(toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>): string {
    const statuses = toolResults
        .map((entry) => formatToolResultStatus(entry))
        .filter((entry) => entry.length > 0);
    if (statuses.length === 0) return 'Agent emitted 0 action(s)';
    return `Agent emitted ${toolResults.length} action(s): ${statuses.join(', ')}`;
}

export function shouldVoiceQaWatchForAsyncTargetFollowUp(
    toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>,
): boolean {
    return toolResults.some((entry) => LOCAL_QA_ASYNC_TARGET_FOLLOW_UP_TOOL_NAMES.has(normalizeVoiceQaText(entry?.t)));
}
