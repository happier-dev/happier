import { resolveSystemTaskFailureMessage } from './resolveSystemTaskFailureMessage';

export function readSystemTaskStartErrorMessage(error: unknown): string | null {
    if (typeof error === 'string') {
        const trimmed = error.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (error instanceof Error) {
        const code: unknown = Reflect.get(error, 'code');
        return resolveSystemTaskFailureMessage({
            ...(typeof code === 'string' ? { code } : {}),
            message: error.message,
        }) ?? null;
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
