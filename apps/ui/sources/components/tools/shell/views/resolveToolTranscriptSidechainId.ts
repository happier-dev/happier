import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';
import type { ToolCall } from '@happier-dev/session-core/messages';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

export function resolveToolTranscriptSidechainId(params: Readonly<{
    tool: ToolCall;
    normalizedToolName: string;
}>): string | null {
    const { tool, normalizedToolName } = params;

    if (isSubAgentTranscriptToolName(normalizedToolName)) {
        const result = asRecord(tool.result);
        const sidechainId = readNonBlankOpaqueIdentifier(result?.sidechainId);
        if (sidechainId) return sidechainId;

        const input = asRecord(tool.input);
        const inputSidechainId = readNonBlankOpaqueIdentifier(input?.sidechainId) ?? readNonBlankOpaqueIdentifier(input?.callId);
        if (inputSidechainId) return inputSidechainId;
    }

    const toolId = typeof tool.id === 'string' ? tool.id.trim() : '';
    return toolId.length > 0 ? toolId : null;
}
