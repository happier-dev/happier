import type { ToolCall } from '../../domains/messages/messageTypes';

export type ReducerStoredPermission = {
    tool: string;
    arguments: any;
    createdAt: number;
    completedAt?: number;
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    kind?: string;
    reason?: string;
    mode?: string;
    allowedTools?: string[];
    // Backward-compatible field name used by some clients/agents.
    allowTools?: string[];
    suggestions?: unknown;
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
};

export function resolveStoredPermissionAllowedTools(permission: Pick<ReducerStoredPermission, 'allowedTools' | 'allowTools'>): string[] | undefined {
    return permission.allowedTools ?? permission.allowTools;
}

export function buildToolPermissionFromStored(
    toolId: string,
    permission: ReducerStoredPermission,
): NonNullable<ToolCall['permission']> {
    return {
        id: toolId,
        status: permission.status,
        kind: permission.kind,
        reason: permission.reason,
        mode: permission.mode,
        allowedTools: resolveStoredPermissionAllowedTools(permission),
        decision: permission.decision,
        suggestions: permission.suggestions,
    };
}

export function getCompletedAllowedTools(completed: Readonly<{
    allowedTools?: unknown;
    allowTools?: unknown;
    updatedPermissions?: unknown;
}>): string[] | undefined {
    const list = completed.allowedTools ?? completed.allowTools;
    if (Array.isArray(list)) return list.filter((item): item is string => typeof item === 'string');

    if (!Array.isArray(completed.updatedPermissions) || completed.updatedPermissions.length === 0) {
        return undefined;
    }

    const derived = new Set<string>();
    for (const update of completed.updatedPermissions) {
        if (!update || typeof update !== 'object' || Array.isArray(update)) continue;
        const rec = update as Record<string, unknown>;
        if (rec.type !== 'addRules' || rec.behavior !== 'allow') continue;
        const rules = rec.rules;
        if (!Array.isArray(rules) || rules.length === 0) continue;
        for (const rule of rules) {
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
            const ruleRecord = rule as Record<string, unknown>;
            const toolName = ruleRecord.toolName;
            if (typeof toolName !== 'string' || toolName.length === 0) continue;
            const ruleContent = ruleRecord.ruleContent;
            if (typeof ruleContent === 'string' && ruleContent.length > 0) {
                derived.add(`${toolName}(${ruleContent})`);
            } else {
                derived.add(toolName);
            }
        }
    }

    return derived.size > 0 ? Array.from(derived) : undefined;
}

export function buildReducerStoredPermissionFromCompletedRequest(completed: Readonly<{
    tool: string;
    arguments: any;
    createdAt?: number | null;
    completedAt?: number | null;
    status: 'approved' | 'denied' | 'canceled';
    kind?: string | null;
    reason?: string | null;
    mode?: string | null;
    allowedTools?: unknown;
    allowTools?: unknown;
    updatedPermissions?: unknown;
    decision?: ReducerStoredPermission['decision'] | null;
}>): ReducerStoredPermission {
    return {
        tool: completed.tool,
        arguments: completed.arguments,
        createdAt: completed.createdAt || Date.now(),
        completedAt: completed.completedAt || undefined,
        status: completed.status,
        kind: typeof completed.kind === 'string' ? completed.kind : undefined,
        reason: completed.reason || undefined,
        mode: completed.mode || undefined,
        allowedTools: getCompletedAllowedTools(completed),
        decision: completed.decision || undefined,
    };
}

export function applyStoredPermissionTerminalState(
    toolCall: ToolCall,
    permission: ReducerStoredPermission,
    fallbackCompletedAt: number,
): void {
    if (permission.status === 'approved' || permission.status === 'pending') return;

    toolCall.state = 'error';
    toolCall.completedAt = permission.completedAt || fallbackCompletedAt;
    if (permission.reason) {
        toolCall.result = { error: permission.reason };
    }
}

export function createTranscriptToolCallProjection(params: Readonly<{
    toolId: string;
    toolName: string;
    toolInput: unknown;
    description: string | null;
    messageCreatedAt: number;
    permission?: ReducerStoredPermission;
    isPendingPermissionRequest: boolean;
}>): Readonly<{
    toolCall: ToolCall;
    shouldStorePendingPermission: boolean;
}> {
    const toolInput = params.permission ? params.permission.arguments : params.toolInput;
    const toolCreatedAt = params.permission ? params.permission.createdAt : params.messageCreatedAt;
    const pendingPermission = !params.permission && params.isPendingPermissionRequest;
    const toolCall: ToolCall = {
        id: params.toolId,
        name: params.toolName,
        state: 'running',
        input: toolInput,
        createdAt: toolCreatedAt,
        startedAt: pendingPermission ? null : params.messageCreatedAt,
        completedAt: null,
        description: params.description,
        result: undefined,
    };

    if (params.permission) {
        toolCall.permission = buildToolPermissionFromStored(params.toolId, params.permission);
        applyStoredPermissionTerminalState(toolCall, params.permission, params.messageCreatedAt);
    } else if (pendingPermission) {
        toolCall.permission = { id: params.toolId, status: 'pending' };
    }

    return {
        toolCall,
        shouldStorePendingPermission: pendingPermission,
    };
}
