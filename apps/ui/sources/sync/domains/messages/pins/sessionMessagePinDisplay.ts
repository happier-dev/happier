import type { SessionMessagePinRole } from './sessionMessagePinIdentity';

export const SESSION_MESSAGE_PIN_LABEL_MAX_LENGTH = 120;

export type SessionMessagePinDisplayRole = 'user' | 'assistant' | 'tool' | 'unknown';

export function normalizeSessionMessagePinLabel(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > SESSION_MESSAGE_PIN_LABEL_MAX_LENGTH
        ? trimmed.slice(0, SESSION_MESSAGE_PIN_LABEL_MAX_LENGTH)
        : trimmed;
}

export function resolveSessionMessagePinDisplayRole(role: SessionMessagePinRole): SessionMessagePinDisplayRole {
    return role === 'user' || role === 'assistant' || role === 'tool' ? role : 'unknown';
}
