export type SessionTurnLifecycleEvent =
    | 'task_started'
    | 'task_complete'
    | 'turn_aborted'
    | 'turn_failed'
    | 'turn_cancelled'
    | 'ready';

export function detectSessionTurnLifecycleEvent(value: unknown): SessionTurnLifecycleEvent | null {
    const obj = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    if (!obj || obj.role !== 'agent') return null;

    const content = obj.content;
    const contentObj = content && typeof content === 'object' && !Array.isArray(content)
        ? (content as Record<string, unknown>)
        : null;
    if (!contentObj) return null;

    if (contentObj.type === 'acp') {
        const data = contentObj.data;
        const dataObj = data && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : null;
        const dataType = typeof dataObj?.type === 'string' ? dataObj.type : null;
        if (
            dataType === 'task_started'
            || dataType === 'task_complete'
            || dataType === 'turn_aborted'
            || dataType === 'turn_failed'
            || dataType === 'turn_cancelled'
        ) {
            return dataType;
        }
        return null;
    }

    if (contentObj.type === 'event') {
        const data = contentObj.data;
        const dataObj = data && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : null;
        return dataObj?.type === 'ready' ? 'ready' : null;
    }

    return null;
}

export function applySessionTurnLifecycleEvent(params: Readonly<{
    pendingUserTurns: number;
    activeTaskInFlight: boolean;
    event: SessionTurnLifecycleEvent;
}>): Readonly<{
    pendingUserTurns: number;
    activeTaskInFlight: boolean;
}> {
    if (params.event === 'task_started') {
        return {
            pendingUserTurns: params.pendingUserTurns > 0 ? params.pendingUserTurns - 1 : 0,
            activeTaskInFlight: true,
        };
    }

    if (params.activeTaskInFlight) {
        return {
            pendingUserTurns: params.pendingUserTurns,
            activeTaskInFlight: false,
        };
    }

    return {
        pendingUserTurns: params.pendingUserTurns > 0 ? params.pendingUserTurns - 1 : 0,
        activeTaskInFlight: false,
    };
}
