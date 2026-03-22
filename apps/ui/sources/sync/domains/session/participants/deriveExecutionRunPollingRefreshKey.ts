import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';

const EXECUTION_RUN_ID_REGEX = /run_[0-9a-f-]{8,}/gi;

export function readExecutionRunIdFromToolPayload(tool: ToolCall): string | null {
    const input = tool.input as any;
    const inputRunId = typeof input?.runId === 'string' ? String(input.runId).trim() : '';
    if (inputRunId.length > 0) return inputRunId;

    const result = tool.result as any;
    const resultRunId = typeof result?.runId === 'string' ? String(result.runId).trim() : '';
    return resultRunId.length > 0 ? resultRunId : null;
}

export function extractExecutionRunIdsFromText(text: string): readonly string[] {
    const matches = text.match(EXECUTION_RUN_ID_REGEX);
    if (!matches) return [];
    return matches.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

export function extractExecutionRunIdsFromUnknown(value: unknown, depth = 0): readonly string[] {
    if (depth > 5 || value == null) return [];

    if (typeof value === 'string') return extractExecutionRunIdsFromText(value);

    if (Array.isArray(value)) {
        const runIds = new Set<string>();
        for (const item of value) {
            for (const runId of extractExecutionRunIdsFromUnknown(item, depth + 1)) {
                runIds.add(runId);
            }
        }
        return Array.from(runIds);
    }

    if (typeof value === 'object') {
        const runIds = new Set<string>();
        for (const entry of Object.values(value as Record<string, unknown>)) {
            for (const runId of extractExecutionRunIdsFromUnknown(entry, depth + 1)) {
                runIds.add(runId);
            }
        }
        return Array.from(runIds);
    }

    return [];
}

export function toolNameLooksLikeExecutionRunStart(name: string | null | undefined): boolean {
    if (!name) return false;
    const value = String(name).trim().toLowerCase();
    if (!value) return false;
    return (
        value.includes('execution run start')
        || value.includes('execution_run_start')
        || value.includes('delegate start')
        || value.includes('delegate_start')
        || value.includes('subagents delegate start')
        || value.includes('subagents_delegate_start')
    );
}

export function toolNameLooksLikeExecutionRunStop(name: string | null | undefined): boolean {
    if (!name) return false;
    const value = String(name).trim().toLowerCase();
    if (!value) return false;
    return (
        value.includes('execution run stop')
        || value.includes('execution_run_stop')
        || value.includes('delegate run stop')
        || value.includes('delegate_stop')
    );
}

function serializeSignalBucket(prefix: string, runIds: ReadonlySet<string>): string {
    return `${prefix}:${Array.from(runIds).sort().join(',')}`;
}

export function deriveExecutionRunPollingRefreshKey(messages: readonly Message[]): string {
    const subAgentRunIds = new Set<string>();
    const startedRunIds = new Set<string>();
    const stoppedRunIds = new Set<string>();

    for (const message of messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const tool = message.tool;
        if (!tool) continue;

        if (isSubAgentTranscriptToolName(tool.name)) {
            const runId = readExecutionRunIdFromToolPayload(tool);
            const signalId =
                runId
                ?? (typeof tool.id === 'string' ? tool.id.trim() : '');
            if (signalId) subAgentRunIds.add(signalId);
        }

        if (toolNameLooksLikeExecutionRunStart(tool.name)) {
            const directRunId = readExecutionRunIdFromToolPayload(tool);
            if (directRunId) startedRunIds.add(directRunId);
            for (const runId of extractExecutionRunIdsFromUnknown(tool.result)) {
                startedRunIds.add(runId);
            }
        }

        if (toolNameLooksLikeExecutionRunStop(tool.name)) {
            const directRunId = readExecutionRunIdFromToolPayload(tool);
            if (directRunId) stoppedRunIds.add(directRunId);
            for (const runId of extractExecutionRunIdsFromUnknown(tool.result)) {
                stoppedRunIds.add(runId);
            }
        }
    }

    return [
        serializeSignalBucket('subagent', subAgentRunIds),
        serializeSignalBucket('started', startedRunIds),
        serializeSignalBucket('stopped', stoppedRunIds),
    ].join('|');
}
