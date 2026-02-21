import { getErrorMessage } from './getErrorMessage';

export function formatOperationFailedDebugMessage(baseMessage: string, error: unknown): string {
    const base = String(baseMessage ?? '').trim();
    const detail = getErrorMessage(error).trim();
    if (!base) return detail || '';
    if (!detail) return base;
    return `${base}\n\n${detail}`;
}

