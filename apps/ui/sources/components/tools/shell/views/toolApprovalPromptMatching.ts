import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';

function stableSerialize(value: unknown): string | null {
    if (typeof value === 'undefined') return null;
    try {
        return JSON.stringify(value, (_key, nested) => {
            if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(nested).sort()) sorted[key] = (nested as Record<string, unknown>)[key];
            return sorted;
        });
    } catch {
        return null;
    }
}

export function doesApprovalMatchToolCall(params: Readonly<{
    request: OpenApprovalArtifactForSession;
    sessionId: string | undefined;
    messageId: string | undefined;
    tool: ToolCall;
    normalizedToolName: string;
}>): boolean {
    const origin = params.request.approval.origin;
    if (origin?.kind !== 'transcript_tool_call') return false;
    if (!params.sessionId || origin.sessionId !== params.sessionId) return false;
    if (origin.messageId || origin.parentMessageId) {
        if (params.messageId && (origin.messageId === params.messageId || origin.parentMessageId === params.messageId)) {
            return true;
        }
        if (origin.toolCallId) {
            return typeof params.tool.id === 'string' && origin.toolCallId === params.tool.id;
        }
        return false;
    }
    if (origin.toolCallId) {
        return typeof params.tool.id === 'string' && origin.toolCallId === params.tool.id;
    }
    if (origin.toolName !== params.tool.name && origin.toolName !== params.normalizedToolName) return false;
    const originInput = stableSerialize(origin.toolInput);
    return originInput == null || originInput === stableSerialize(params.tool.input);
}

export function buildApprovalToolCallLocation(params: Readonly<{
    messageId: string | undefined;
}>): PermissionToolCallMessageLocation | null {
    if (!params.messageId) return null;
    return { kind: 'top', messageId: params.messageId, seq: null };
}
