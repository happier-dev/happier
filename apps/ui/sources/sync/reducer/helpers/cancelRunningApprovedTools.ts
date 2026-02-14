import type { ReducerState } from '../reducer';

function cancelRunningApprovedTool(
    state: ReducerState,
    changed: Set<string>,
    messageId: string,
    completedAt: number,
    reason: string,
    opts?: { requireApprovedPermission?: boolean },
): boolean {
    const message = state.messages.get(messageId);
    const tool = message?.tool;
    if (!tool) return false;
    if (tool.state !== 'running') return false;
    const requireApprovedPermission = opts?.requireApprovedPermission !== false;
    if (requireApprovedPermission) {
        if (tool.permission?.status !== 'approved') return false;
        if (!tool.startedAt) return false;
    }

    tool.state = 'error';
    tool.completedAt = completedAt;
    if (tool.permission) {
        tool.permission.status = 'canceled';
        if (!tool.permission.reason) {
            tool.permission.reason = reason;
        }
    }
    if (tool.result === undefined || tool.result === null) {
        tool.result = { error: reason };
    }
    changed.add(messageId);
    return true;
}

export function cancelRunningApprovedTools(params: Readonly<{
    state: ReducerState;
    changed: Set<string>;
    completedAt: number;
    reason: string;
    preferredToolId?: string | null;
}>): number {
    const { state, changed, completedAt, reason, preferredToolId } = params;

    if (preferredToolId) {
        const preferredMessageId = state.toolIdToMessageId.get(preferredToolId);
        if (
            preferredMessageId &&
            cancelRunningApprovedTool(state, changed, preferredMessageId, completedAt, reason)
        ) {
            return 1;
        }
    }

    let count = 0;
    for (const [messageId] of state.messages) {
        if (cancelRunningApprovedTool(state, changed, messageId, completedAt, reason)) {
            count += 1;
        }
    }
    return count;
}

export function cancelRunningTools(params: Readonly<{
    state: ReducerState;
    changed: Set<string>;
    completedAt: number;
    reason: string;
    preferredToolId?: string | null;
}>): number {
    const { state, changed, completedAt, reason, preferredToolId } = params;

    if (preferredToolId) {
        const preferredMessageId = state.toolIdToMessageId.get(preferredToolId);
        if (
            preferredMessageId &&
            cancelRunningApprovedTool(state, changed, preferredMessageId, completedAt, reason, { requireApprovedPermission: false })
        ) {
            return 1;
        }
    }

    let count = 0;
    for (const [messageId] of state.messages) {
        if (cancelRunningApprovedTool(state, changed, messageId, completedAt, reason, { requireApprovedPermission: false })) {
            count += 1;
        }
    }
    return count;
}
