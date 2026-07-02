import type { SessionEventMessage } from '@/api/session/sessionMessageTypes';

export type ClaudeCompletionEvent = string | SessionEventMessage;

export function buildClaudeCompactionLifecycleId(params: Readonly<{
    sessionId: string | null | undefined;
    sequence: number;
}>): string {
    const sessionPart = typeof params.sessionId === 'string' && params.sessionId.trim()
        ? params.sessionId.trim()
        : 'pending';
    return `claude:context-compaction:${sessionPart}:${Math.max(1, Math.trunc(params.sequence))}`;
}

export function buildClaudeCompactionStartedEvent(params: Readonly<{
    lifecycleId: string;
}>): SessionEventMessage {
    return {
        type: 'context-compaction',
        phase: 'started',
        provider: 'claude',
        source: 'user-command',
        trigger: 'manual',
        lifecycleId: params.lifecycleId,
    };
}

export function buildClaudeCompactionCompletedEvent(params: Readonly<{
    lifecycleId: string;
    source?: 'provider-event' | 'runtime';
    trigger?: 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown';
    providerSessionId?: string;
    tokenCountBefore?: number;
    tokenCountSource?: string;
}>): SessionEventMessage {
    return {
        type: 'context-compaction',
        phase: 'completed',
        provider: 'claude',
        source: params.source ?? 'provider-event',
        trigger: params.trigger ?? 'manual',
        lifecycleId: params.lifecycleId,
        ...(params.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
        ...(typeof params.tokenCountBefore === 'number' ? { tokenCountBefore: params.tokenCountBefore } : {}),
        ...(params.tokenCountSource ? { tokenCountSource: params.tokenCountSource } : {}),
    };
}
