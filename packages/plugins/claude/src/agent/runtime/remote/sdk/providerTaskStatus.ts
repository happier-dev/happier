export function normalizeClaudeAgentSdkProviderTaskId(taskId: unknown): string | null {
    if (typeof taskId !== 'string') return null;
    const normalized = taskId.trim();
    return normalized.length > 0 ? normalized : null;
}

export function normalizeClaudeAgentSdkProviderTaskStatus(status: unknown): string | null {
    if (typeof status !== 'string') return null;
    const normalized = status.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

export function readClaudeAgentSdkProviderTaskStatus(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const record = message as Record<string, unknown>;
    const directStatus = normalizeClaudeAgentSdkProviderTaskStatus(record.status);
    if (directStatus) return directStatus;

    const patch = record.patch;
    if (!patch || typeof patch !== 'object') return null;
    return normalizeClaudeAgentSdkProviderTaskStatus((patch as Record<string, unknown>).status);
}

export function isTerminalClaudeAgentSdkProviderTaskStatus(status: unknown): boolean {
    switch (normalizeClaudeAgentSdkProviderTaskStatus(status)) {
        case 'completed':
        case 'succeeded':
        case 'success':
        case 'stopped':
        case 'failed':
        case 'error':
        case 'errored':
        case 'cancelled':
        case 'canceled':
            return true;
        default:
            return false;
    }
}
