import type { ToolCall } from '@/sync/domains/messages/messageTypes';

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

export function resolveToolTranscriptSidechainId(params: Readonly<{
    tool: ToolCall;
    normalizedToolName: string;
}>): string | null {
    const { tool, normalizedToolName } = params;

    if (normalizedToolName === 'SubAgentRun') {
        const result = asRecord(tool.result);
        const sidechainId = readNonEmptyString(result?.sidechainId);
        if (sidechainId) return sidechainId;

        const input = asRecord(tool.input);
        const inputSidechainId = readNonEmptyString(input?.sidechainId) ?? readNonEmptyString(input?.callId);
        if (inputSidechainId) return inputSidechainId;
    }

    const toolId = typeof tool.id === 'string' ? tool.id.trim() : '';
    return toolId.length > 0 ? toolId : null;
}
