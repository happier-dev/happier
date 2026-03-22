import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';

export type SessionSubagentDetailsDescriptor = Readonly<{
    id: 'execution_run' | 'tool_transcript';
    matches: (subagent: SessionSubagent) => boolean;
    requiresToolCallMessage: boolean;
}>;

export type ResolveSessionSubagentDetailsDescriptorParams = Readonly<{
    subagent: SessionSubagent;
    message: Message | null;
}>;

export type SessionSubagentTranscriptBodyProps = Readonly<{
    sessionId: string;
    scopeId: string;
    session: Session;
    subagent: SessionSubagent;
    message: Message | null;
}>;
