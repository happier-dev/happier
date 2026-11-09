import type { ToolCall } from "../../messages/messageTypes.js";
import { SessionPermissionApprovalReviewerClaimV1Schema, SessionPermissionDecisionActorV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { SessionQuestionHandlerV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';

export type ReducerStoredPermission = {
    tool: string;
    arguments: any;
    createdAt: number;
    completedAt?: number;
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    turnId?: string;
    source?: string;
    kind?: string;
    reason?: string;
    mode?: string;
    allowedTools?: string[];
    // Backward-compatible field name used by some clients/agents.
    allowTools?: string[];
    suggestions?: unknown;
    nativeChoices?: NonNullable<ToolCall['permission']>['nativeChoices'];
    nativeChoice?: NonNullable<ToolCall['permission']>['nativeChoice'];
    mcpTool?: NonNullable<ToolCall['permission']>['mcpTool'];
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    decisionActor?: NonNullable<ToolCall['permission']>['decisionActor'];
    answeredBy?: NonNullable<ToolCall['permission']>['answeredBy'];
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
        turnId: permission.turnId,
        source: permission.source,
        status: permission.status,
        kind: permission.kind,
        reason: permission.reason,
        mode: permission.mode,
        allowedTools: resolveStoredPermissionAllowedTools(permission),
        decision: permission.decision,
        suggestions: permission.suggestions,
        ...(permission.nativeChoices ? { nativeChoices: permission.nativeChoices } : {}),
        ...(permission.nativeChoice ? { nativeChoice: permission.nativeChoice } : {}),
        ...(permission.mcpTool ? { mcpTool: permission.mcpTool } : {}),
        ...(permission.decisionActor ? { decisionActor: permission.decisionActor } : {}),
        ...(permission.answeredBy ? { answeredBy: permission.answeredBy } : {}),
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
    turnId?: string;
    source?: string;
    reason?: string | null;
    mode?: string | null;
    allowedTools?: unknown;
    allowTools?: unknown;
    updatedPermissions?: unknown;
    decision?: ReducerStoredPermission['decision'] | null;
    permissionDecisionActorV1?: unknown;
    permissionDecisionClaimV1?: unknown;
    answeredBy?: unknown;
    mcpTool?: unknown;
    nativeChoices?: ReducerStoredPermission['nativeChoices'];
    nativeChoice?: ReducerStoredPermission['nativeChoice'];
}>): ReducerStoredPermission {
    const actor = SessionPermissionDecisionActorV1Schema.safeParse(completed.permissionDecisionActorV1);
    const answeredBy = SessionQuestionHandlerV1Schema.safeParse(completed.answeredBy);
    const mcpTool = ResolvedMcpToolIdentityV1Schema.safeParse(completed.mcpTool);
    const reviewerClaim = SessionPermissionApprovalReviewerClaimV1Schema.safeParse(completed.permissionDecisionClaimV1);
    const decisionActor = reviewerClaim.success && completed.status === 'approved'
        ? { kind: 'approvalReviewer' as const }
        : actor.success && actor.data.kind !== 'approvalReviewer' ? actor.data : undefined;
    return {
        tool: completed.tool,
        arguments: completed.arguments,
        createdAt: completed.createdAt || Date.now(),
        completedAt: completed.completedAt || undefined,
        status: completed.status,
        turnId: completed.turnId,
        source: completed.source,
        kind: typeof completed.kind === 'string' ? completed.kind : undefined,
        reason: completed.reason || undefined,
        mode: completed.mode || undefined,
        allowedTools: getCompletedAllowedTools(completed),
        decision: completed.decision || undefined,
        ...(completed.nativeChoices ? { nativeChoices: completed.nativeChoices } : {}),
        ...(completed.nativeChoice ? { nativeChoice: completed.nativeChoice } : {}),
        ...(mcpTool.success ? { mcpTool: mcpTool.data } : {}),
        ...(decisionActor ? { decisionActor } : {}),
        ...(answeredBy.success ? { answeredBy: answeredBy.data } : {}),
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
    sourceToolId?: string;
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
        ...(params.sourceToolId ? { sourceToolId: params.sourceToolId } : {}),
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
