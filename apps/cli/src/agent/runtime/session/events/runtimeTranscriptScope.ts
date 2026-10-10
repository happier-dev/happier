import type { AgentSessionRuntimeEvent } from '@happier-dev/protocol/runtime';

type RuntimeTranscriptEvent = Extract<AgentSessionRuntimeEvent, {
    kind: 'message-delta' | 'tool-call' | 'tool-progress' | 'tool-result' | 'file-edit' | 'transcript-message-committed';
}>;

function isRuntimeTranscriptEvent(event: AgentSessionRuntimeEvent): event is RuntimeTranscriptEvent {
    return event.kind === 'message-delta'
        || event.kind === 'tool-call'
        || event.kind === 'tool-progress'
        || event.kind === 'tool-result'
        || event.kind === 'file-edit'
        || event.kind === 'transcript-message-committed';
}

export function isForegroundTurnRuntimeTranscriptEvent(
    event: AgentSessionRuntimeEvent,
): event is RuntimeTranscriptEvent & Readonly<{ turnId: string }> {
    return isRuntimeTranscriptEvent(event) && event.turnId !== undefined && event.sidechainId === undefined;
}

/** Native child output retains transcript correlation without foreground turn authority. */
export function isSessionScopedRuntimeTranscriptEvent(event: AgentSessionRuntimeEvent): boolean {
    return isRuntimeTranscriptEvent(event) && !isForegroundTurnRuntimeTranscriptEvent(event);
}
