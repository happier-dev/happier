import type { ToolCall } from '@/sync/domains/messages/messageTypes';

export type ToolStatusIndicatorKind =
    | 'permission_blocked'
    | 'permission_pending'
    | 'running'
    | 'completed'
    | 'error'
    | 'none';

function hasToolUseResultErrorString(tool: ToolCall): boolean {
    const result = tool.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const record = result as Record<string, unknown>;
    const toolUseResult = record.tool_use_result;
    if (typeof toolUseResult !== 'string') return false;
    return toolUseResult.trim().toLowerCase().startsWith('error:');
}

export function resolveToolStatusIndicatorKind(tool: ToolCall): ToolStatusIndicatorKind {
    const permissionStatus = tool.permission?.status;
    if (permissionStatus === 'denied' || permissionStatus === 'canceled') return 'permission_blocked';
    if (permissionStatus === 'pending' && tool.state === 'running') return 'permission_pending';

    if (tool.state === 'running') return 'running';
    if (tool.state === 'error') return 'error';
    if (tool.state === 'completed') {
        return hasToolUseResultErrorString(tool) ? 'error' : 'completed';
    }
    return 'none';
}
