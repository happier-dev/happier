import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import {
    buildCodexSyntheticSubagentToolCall,
    buildCodexSyntheticSubagentToolResult,
} from './buildCodexSyntheticSubagentToolMessages';

type SessionLike = Readonly<{
    sendAgentMessage: (
        provider: 'codex',
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) => void;
}>;

type SubagentThreadState = Readonly<{
    rootToolCallSent: boolean;
    rootToolResultSent: boolean;
}>;

type SubagentMetadata = Readonly<{
    threadId: string;
    prompt?: string | null;
    nickname?: string | null;
    role?: string | null;
}>;

export function createCodexSyntheticSubagentTracker(params: Readonly<{
    session: SessionLike;
}>) {
    const stateByThreadId = new Map<string, SubagentThreadState>();

    const ensureStarted = (metadata: SubagentMetadata): void => {
        const current = stateByThreadId.get(metadata.threadId);
        if (current?.rootToolCallSent) return;

        params.session.sendAgentMessage('codex', buildCodexSyntheticSubagentToolCall(metadata));
        stateByThreadId.set(metadata.threadId, {
            rootToolCallSent: true,
            rootToolResultSent: current?.rootToolResultSent ?? false,
        });
    };

    const finalize = (metadata: Readonly<{ threadId: string; status: 'completed' | 'interrupted' }>): void => {
        const current = stateByThreadId.get(metadata.threadId);
        if (!current?.rootToolCallSent) {
            ensureStarted({ threadId: metadata.threadId });
        }
        const latest = stateByThreadId.get(metadata.threadId);
        if (latest?.rootToolResultSent) return;

        params.session.sendAgentMessage('codex', buildCodexSyntheticSubagentToolResult(metadata));
        stateByThreadId.set(metadata.threadId, {
            rootToolCallSent: true,
            rootToolResultSent: true,
        });
    };

    return {
        ensureStarted,
        finalize,

        hasStarted(threadId: string): boolean {
            return stateByThreadId.get(threadId)?.rootToolCallSent === true;
        },
    };
}
