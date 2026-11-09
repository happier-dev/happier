import type { ToolCall } from "@happier-dev/session-core/messages";
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';

export function resolveInactiveSessionToolCallFailure(params: Readonly<{
    tool: ToolCall;
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
}>): ToolCall {
    if (params.permissionDisabledReason !== 'inactive') return params.tool;
    if (params.tool.state !== 'running') return params.tool;

    // Unsettled calls on a stopped Session use the existing interrupted
    // presentation without changing their retained result or approval.
    const permission = params.tool.permission;
    return {
        ...params.tool,
        state: 'error',
        ...(permission?.status === 'pending' ? {
            permission: { ...permission, status: 'canceled' as const },
        } : {}),
    };
}
