import type { AgentEvent } from '@/sync/typesRaw';

const TERMINAL_COMPOSER_DRAFT_BLOCKED_EVENT_TYPE = 'terminal-composer-draft-blocked';

const LEGACY_TERMINAL_COMPOSER_DRAFT_MESSAGES = new Set([
    'Your queued message can\'t steer the running turn: the terminal composer holds an unsent draft. Clear the draft in the terminal (or interrupt the turn) to deliver it.',
    'Your queued message is waiting: the terminal composer holds an unsent draft. Clear the draft in the terminal to deliver it.',
]);

function readEventRecord(event: AgentEvent): Record<string, unknown> {
    return event as unknown as Record<string, unknown>;
}

export function isTerminalComposerDraftBlockedEvent(event: AgentEvent): boolean {
    const record = readEventRecord(event);
    if (record.type === TERMINAL_COMPOSER_DRAFT_BLOCKED_EVENT_TYPE) {
        return true;
    }
    return record.type === 'message'
        && typeof record.message === 'string'
        && LEGACY_TERMINAL_COMPOSER_DRAFT_MESSAGES.has(record.message);
}

export function readTerminalComposerDraftBlockedStateAtMs(event: AgentEvent): number | null {
    const record = readEventRecord(event);
    if (record.type !== TERMINAL_COMPOSER_DRAFT_BLOCKED_EVENT_TYPE) return null;
    return typeof record.stateAtMs === 'number' && Number.isFinite(record.stateAtMs)
        ? Math.trunc(record.stateAtMs)
        : null;
}
