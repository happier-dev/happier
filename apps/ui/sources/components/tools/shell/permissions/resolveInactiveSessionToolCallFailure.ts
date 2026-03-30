import type { ToolCall } from '@/sync/domains/messages/messageTypes';

export function resolveInactiveSessionToolCallFailure(params: Readonly<{
    tool: ToolCall;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
}>): ToolCall {
    if (params.permissionDisabledReason !== 'inactive') return params.tool;

    const permission = params.tool.permission;
    if (!permission || permission.status !== 'pending') return params.tool;
    if (params.tool.state !== 'running') return params.tool;

    return {
        ...params.tool,
        state: 'error',
        permission: {
            ...permission,
            status: 'canceled',
        },
    };
}
