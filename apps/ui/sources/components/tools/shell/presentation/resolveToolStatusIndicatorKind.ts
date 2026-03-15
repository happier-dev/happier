import type { ToolCall } from '@/sync/domains/messages/messageTypes';

export type ToolStatusIndicatorKind =
    | 'permission_blocked'
    | 'permission_pending'
    | 'running'
    | 'completed'
    | 'error'
    | 'none';

export function resolveToolStatusIndicatorKind(tool: ToolCall): ToolStatusIndicatorKind {
    const permissionStatus = tool.permission?.status;
    if (permissionStatus === 'denied' || permissionStatus === 'canceled') return 'permission_blocked';
    if (permissionStatus === 'pending' && tool.state === 'running') return 'permission_pending';

    if (tool.state === 'running' || tool.state === 'completed' || tool.state === 'error') return tool.state;
    return 'none';
}
