import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { storage } from '@/sync/domains/state/storage';
import { resolveVoiceToolResultHumanSummary } from '@/voice/context/resolveVoiceToolResultHumanSummary';
import type { LocalVoiceAgentToolResultEntry } from '@/voice/local/runVoiceAgentTurnWithTools';

import { normalizeVoiceQaText } from './voiceQaSessionResolution';

const LOCAL_QA_ASYNC_TARGET_FOLLOW_UP_TOOL_NAMES = new Set(['sendSessionMessage']);

function formatToolResultStatus(
    entry: LocalVoiceAgentToolResultEntry,
    prefs: Readonly<{ shareFilePaths: boolean; shareSessionSummary: boolean }>,
): string {
    const toolName = normalizeVoiceQaText(entry?.t) || 'unknown';
    // Route any human-readable detail through the single canonical privacy helper so the QA
    // surface honors the same `shareSessionSummary`/`shareFilePaths` gating as the live transport.
    const humanSummary = normalizeVoiceQaText(
        resolveVoiceToolResultHumanSummary({
            toolName,
            toolInput: entry?.args,
            toolResult: entry?.result,
            shareFilePaths: prefs.shareFilePaths,
            shareSessionSummary: prefs.shareSessionSummary,
        }) ?? '',
    );
    const detail = humanSummary ? ` ${humanSummary}` : '';
    const result = entry?.result;
    if (result && typeof result === 'object') {
        const record = result as Record<string, unknown>;
        const errorCode = normalizeVoiceQaText(record.errorCode);
        if (errorCode) return `${toolName}(error:${errorCode})${detail}`;
        if (record.ok === true) return `${toolName}(ok)${detail}`;
        if (record.ok === false) return `${toolName}(error)${detail}`;
    }
    return `${toolName}(ok)${detail}`;
}

export function formatVoiceQaToolResultsSummary(toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>): string {
    const privacy = readVoicePrivacySettings((storage.getState() as { settings?: unknown })?.settings);
    const prefs = { shareFilePaths: privacy.shareFilePaths, shareSessionSummary: privacy.shareSessionSummary } as const;
    const statuses = toolResults
        .map((entry) => formatToolResultStatus(entry, prefs))
        .filter((entry) => entry.length > 0);
    if (statuses.length === 0) return 'Agent emitted 0 action(s)';
    return `Agent emitted ${toolResults.length} action(s): ${statuses.join(', ')}`;
}

export function shouldVoiceQaWatchForAsyncTargetFollowUp(
    toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>,
): boolean {
    return toolResults.some((entry) => LOCAL_QA_ASYNC_TARGET_FOLLOW_UP_TOOL_NAMES.has(normalizeVoiceQaText(entry?.t)));
}
