import type { createCodexSyntheticSubagentTracker } from '../collaboration/createCodexSyntheticSubagentTracker';

type CodexSyntheticSubagentTracker = ReturnType<typeof createCodexSyntheticSubagentTracker>;

export async function startCodexSyntheticSubagent(params: Readonly<{
    tracker: CodexSyntheticSubagentTracker;
    flushBoundary: () => Promise<void>;
    threadId: string;
    prompt?: string | null;
    nickname?: string | null;
    role?: string | null;
}>): Promise<void> {
    await params.flushBoundary();
    params.tracker.ensureStarted({
        threadId: params.threadId,
        ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
        ...(params.nickname === undefined ? {} : { nickname: params.nickname }),
        ...(params.role === undefined ? {} : { role: params.role }),
    });
}

export async function finalizeCodexSyntheticSubagent(params: Readonly<{
    tracker: CodexSyntheticSubagentTracker;
    flushBoundary: () => Promise<void>;
    threadId: string;
    status: 'completed' | 'interrupted';
}>): Promise<void> {
    await params.flushBoundary();
    params.tracker.finalize({
        threadId: params.threadId,
        status: params.status,
    });
}
