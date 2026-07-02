import type { Message } from '../../messages/messageTypes';

export function agentTextLooksLikeExecutionRunSignal(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return false;
    return (
        (
            normalized.includes('execution run')
            || normalized.includes('run has been started')
            || normalized.includes('run started')
            || /\brun_[0-9a-z-]{8,}\b/i.test(text)
        )
        && (
            normalized.includes('started')
            || normalized.includes('running')
            || normalized.includes('delegate')
            || normalized.includes('execution run')
        )
    );
}

export function shouldIncludeSubagentSourceMessage(message: Message): boolean {
    if (message.kind === 'tool-call') return true;
    if (message.kind !== 'agent-text') return false;
    const text = typeof (message as { text?: unknown }).text === 'string'
        ? String((message as { text?: unknown }).text)
        : '';
    return agentTextLooksLikeExecutionRunSignal(text);
}
