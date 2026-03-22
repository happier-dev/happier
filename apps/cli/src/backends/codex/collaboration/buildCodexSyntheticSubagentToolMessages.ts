type SubagentMetadata = Readonly<{
    threadId: string;
    prompt?: string | null;
    nickname?: string | null;
    role?: string | null;
}>;

export function buildCodexSyntheticSubagentToolCall(metadata: SubagentMetadata) {
    return {
        type: 'tool-call' as const,
        callId: metadata.threadId,
        name: 'SubAgent',
        input: {
            threadId: metadata.threadId,
            ...(metadata.prompt ? { prompt: metadata.prompt } : {}),
            ...(metadata.nickname ? { nickname: metadata.nickname } : {}),
            ...(metadata.role ? { role: metadata.role } : {}),
        },
        id: metadata.threadId,
    };
}

export function buildCodexSyntheticSubagentToolResult(metadata: Readonly<{
    threadId: string;
    status: 'completed' | 'interrupted';
}>) {
    return {
        type: 'tool-result' as const,
        callId: metadata.threadId,
        output: {
            status: metadata.status,
            threadId: metadata.threadId,
        },
        id: `${metadata.threadId}:${metadata.status}`,
        ...(metadata.status === 'interrupted' ? { isError: true as const } : {}),
    };
}
