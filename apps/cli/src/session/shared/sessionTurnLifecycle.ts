export type SessionTurnLifecycleEvent =
    | 'task_started'
    | 'task_complete'
    | 'turn_aborted'
    | 'turn_failed'
    | 'turn_cancelled'
    | 'ready';

const TERMINAL_OUTPUT_STOP_REASONS = new Set([
    'end_turn',
    'stop',
    'stop_sequence',
    'max_tokens',
    'length',
    'complete',
    'completed',
    'success',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hasTextPart(parts: readonly unknown[]): boolean {
    return parts.some((part) => {
        const partObj = asRecord(part);
        return partObj?.type === 'text' && typeof partObj.text === 'string' && partObj.text.trim().length > 0;
    });
}

function isTerminalOutputStopReason(value: unknown): boolean {
    const reason = readString(value)?.toLowerCase();
    return reason ? TERMINAL_OUTPUT_STOP_REASONS.has(reason) : false;
}

function readLifecycleEventType(value: unknown): SessionTurnLifecycleEvent | null {
    const type = typeof value === 'string' ? value : null;
    if (
        type === 'task_started'
        || type === 'task_complete'
        || type === 'turn_aborted'
        || type === 'turn_failed'
        || type === 'turn_cancelled'
        || type === 'ready'
    ) {
        return type;
    }
    return null;
}

function detectOutputLifecycleEvent(contentObj: Record<string, unknown>): SessionTurnLifecycleEvent | null {
    const dataObj = asRecord(contentObj.data);
    if (dataObj?.type !== 'assistant') return null;

    const messageObj = asRecord(dataObj.message);
    const parts = Array.isArray(messageObj?.content) ? messageObj.content : [];
    if (!hasTextPart(parts)) return null;

    if (
        !isTerminalOutputStopReason(messageObj?.stop_reason)
        && !isTerminalOutputStopReason(messageObj?.stopReason)
        && !isTerminalOutputStopReason(dataObj.stop_reason)
        && !isTerminalOutputStopReason(dataObj.stopReason)
    ) {
        return null;
    }

    return 'ready';
}

export function detectSessionTurnLifecycleEvent(value: unknown): SessionTurnLifecycleEvent | null {
    const obj = asRecord(value);
    if (!obj || (obj.role !== 'agent' && obj.role !== 'event')) return null;

    const content = obj.content;
    const contentObj = asRecord(content);
    if (!contentObj) return null;

    if (contentObj.type === 'text') {
        return obj.role === 'agent' ? 'ready' : null;
    }

    if (contentObj.type === 'acp' || contentObj.type === 'codex') {
        const data = contentObj.data;
        const dataObj = asRecord(data);
        const dataType = typeof dataObj?.type === 'string' ? dataObj.type : null;
        if (dataType === 'message') {
            return 'ready';
        }
        const lifecycleEvent = readLifecycleEventType(dataType);
        if (!lifecycleEvent) return null;
        return lifecycleEvent === 'ready' ? null : lifecycleEvent;
    }

    if (contentObj.type === 'event') {
        const data = contentObj.data;
        const dataObj = asRecord(data);
        return readLifecycleEventType(dataObj?.type);
    }

    if (contentObj.type === 'output') {
        return detectOutputLifecycleEvent(contentObj);
    }

    return null;
}

export function isBareSessionReadyEvent(value: unknown): boolean {
    const obj = asRecord(value);
    if (!obj || (obj.role !== 'agent' && obj.role !== 'event')) return false;

    const content = obj.content;
    const contentObj = asRecord(content);
    if (contentObj?.type !== 'event') return false;

    const data = contentObj.data;
    const dataObj = asRecord(data);
    return dataObj?.type === 'ready';
}

export function isSessionTurnCompletionProof(value: unknown): boolean {
    const lifecycleEvent = detectSessionTurnLifecycleEvent(value);
    if (!lifecycleEvent || isBareSessionReadyEvent(value)) {
        return false;
    }
    return lifecycleEvent === 'ready' || lifecycleEvent === 'task_complete';
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
