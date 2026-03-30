export function readSystemTaskStartErrorMessage(error: unknown): string | null {
    if (typeof error === 'string') {
        const trimmed = error.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (error instanceof Error) {
        const trimmed = error.message.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}

export function isSystemTaskBridgeUnavailableError(error: unknown): boolean {
    const message = readSystemTaskStartErrorMessage(error)?.toLowerCase();
    if (!message) {
        return false;
    }
    return (
        message === 'system_tasks_unavailable'
        || message === 'system task bridge unavailable'
        || message === 'system tasks are not available in this build yet.'
    );
}
